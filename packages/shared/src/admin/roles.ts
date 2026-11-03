import { z } from 'zod';

/** Roles, departments and the shapes the administration screens exchange for them. */

export const ROLE_STATUSES = ['active', 'archived'] as const;
export type RoleStatus = (typeof ROLE_STATUSES)[number];

export const RoleSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** True for the roles the product ships. They are shared, read-only, and cannot be archived. */
  isSystem: z.boolean(),
  status: z.enum(ROLE_STATUSES),
  permissions: z.array(z.string()),
  /** How many accounts in this company hold it. Archiving is refused while this is above zero. */
  accountCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Role = z.infer<typeof RoleSchema>;

export const CreateRoleSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(60),
  description: z.string().trim().max(300).nullish().transform((v) => v || null),
  permissions: z.array(z.string()).default([]),
  /** Start from an existing role's grants rather than an empty matrix. */
  copyFromRoleId: z.string().nullish().transform((v) => v || null),
});

export const UpdateRoleSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  description: z.string().trim().max(300).nullish().transform((v) => v || null).optional(),
  permissions: z.array(z.string()).optional(),
});

export const RoleQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

// =================================================================================== departments

export const DEPARTMENT_STATUSES = ['active', 'inactive'] as const;
export type DepartmentStatus = (typeof DEPARTMENT_STATUSES)[number];

export const DepartmentSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  parentDepartmentId: z.string().nullable(),
  parentName: z.string().nullable(),
  managerEmployeeId: z.string().nullable(),
  managerName: z.string().nullable(),
  status: z.enum(DEPARTMENT_STATUSES),
  /**
   * True for the departments the workforce already uses. Their `code` is written into every
   * employee row, so it is fixed; the display name is not.
   */
  isSystem: z.boolean(),
  /** Employees whose department is this one. Real count, not an estimate. */
  employeeCount: z.number(),
  createdAt: z.string(),
});
export type Department = z.infer<typeof DepartmentSchema>;

export const CreateDepartmentSchema = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .min(2, 'Code is required')
    .max(30)
    .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores'),
  name: z.string().trim().min(2, 'Name is required').max(80),
  description: z.string().trim().max(300).nullish().transform((v) => v || null),
  parentDepartmentId: z.string().nullish().transform((v) => v || null),
  managerEmployeeId: z.string().nullish().transform((v) => v || null),
});

export const UpdateDepartmentSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(300).nullish().transform((v) => v || null).optional(),
  parentDepartmentId: z.string().nullish().transform((v) => v || null).optional(),
  managerEmployeeId: z.string().nullish().transform((v) => v || null).optional(),
  status: z.enum(DEPARTMENT_STATUSES).optional(),
});

/**
 * A department tree node.
 *
 * Depth is capped when building it: a cycle in `parent_department_id` would otherwise render as an
 * infinite tree, and a company that has pointed two departments at each other should see the
 * problem rather than a hung page.
 */
export interface DepartmentNode extends Department {
  children: DepartmentNode[];
  depth: number;
}

export const MAX_DEPARTMENT_DEPTH = 6;

/** Builds the hierarchy, leaving anything unreachable (cycle, missing parent) at the root. */
export function buildDepartmentTree(departments: Department[]): DepartmentNode[] {
  const byId = new Map<string, DepartmentNode>(
    departments.map((d) => [d.id, { ...d, children: [], depth: 0 }]),
  );
  const roots: DepartmentNode[] = [];

  const rootOf = (node: DepartmentNode, seen: Set<string>): boolean => {
    let current = node;
    while (current.parentDepartmentId) {
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      const parent = byId.get(current.parentDepartmentId);
      if (!parent) return false;
      current = parent;
    }
    return true;
  };

  for (const node of byId.values()) {
    const parent = node.parentDepartmentId ? byId.get(node.parentDepartmentId) : undefined;
    if (parent && rootOf(node, new Set())) parent.children.push(node);
    else roots.push(node);
  }

  const setDepth = (nodes: DepartmentNode[], depth: number): void => {
    for (const node of nodes) {
      node.depth = depth;
      node.children.sort((a, b) => a.name.localeCompare(b.name));
      if (depth < MAX_DEPARTMENT_DEPTH) setDepth(node.children, depth + 1);
      else node.children = [];
    }
  };
  roots.sort((a, b) => a.name.localeCompare(b.name));
  setDepth(roots, 0);
  return roots;
}
