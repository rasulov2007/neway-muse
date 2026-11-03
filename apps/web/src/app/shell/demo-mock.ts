import { vi } from 'vitest';

/**
 * Minimal stand-in for `@/demo` used by the shell tests. Notifications are stateful so
 * "mark read" round-trips through `listNotifications`.
 */
export interface MockNotification {
  id: string;
  severity: 'critical' | 'warning' | 'info' | 'success';
  title: string;
  body: string;
  department: string;
  entity: { type: string; id: string; label: string } | null;
  source: string;
  at: string;
  readAt: string | null;
}

export function createDemoMock() {
  const seed = (): MockNotification[] => [
    {
      id: 'ntf_1',
      severity: 'critical',
      title: 'Load L-100245 at risk of late delivery',
      body: 'ETA slipped 2 h past the appointment window.',
      department: 'dispatch',
      entity: { type: 'load', id: 'ld_1', label: 'Load L-100245' },
      source: 'ai',
      at: new Date(Date.now() - 20 * 60_000).toISOString(),
      readAt: null,
    },
    {
      id: 'ntf_2',
      severity: 'success',
      title: 'Invoice INV-2041 paid',
      body: 'Payment received from Great Lakes Logistics.',
      department: 'accounting',
      entity: null,
      source: 'system',
      at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      readAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
  ];
  const notifications: MockNotification[] = seed();

  const unreadCount = () => notifications.filter((n) => n.readAt === null).length;

  return {
    /** Restores the seeded notifications between tests. */
    __reset: () => {
      notifications.splice(0, notifications.length, ...seed());
    },
    demoCompany: { id: 'co_northwind', name: 'Northwind Freight' },
    demoCurrentUser: {
      id: 'usr_001',
      name: 'Sarah Chen',
      email: 'sarah.chen@northwindfreight.com',
      title: 'Operations Manager',
      role: 'Admin',
    },
    demoUsers: [
      {
        id: 'usr_001',
        name: 'Sarah Chen',
        email: 'sarah.chen@northwindfreight.com',
        title: 'Operations Manager',
        role: 'Admin',
      },
    ],
    demoMemberships: [
      {
        companyId: 'co_northwind',
        companyName: 'Northwind Freight',
        companyCity: 'Naperville, IL',
        role: 'Operations Manager',
        status: 'active',
        isCurrent: true,
      },
      {
        companyId: 'co_lakeside',
        companyName: 'Lakeside Carriers',
        companyCity: 'Milwaukee, WI',
        role: 'Dispatcher',
        status: 'active',
        isCurrent: false,
      },
      {
        companyId: 'co_summit',
        companyName: 'Summit Express',
        companyCity: 'Denver, CO',
        role: 'Viewer',
        status: 'pending',
        isCurrent: false,
      },
    ],
    listNotifications: vi.fn(async () => ({
      data: notifications.map((n) => ({ ...n })),
      total: notifications.length,
      unread: unreadCount(),
    })),
    markNotificationRead: vi.fn(async (id: string) => {
      const n = notifications.find((x) => x.id === id);
      if (n && n.readAt === null) n.readAt = new Date().toISOString();
      return n ? { ...n } : null;
    }),
    markAllNotificationsRead: vi.fn(async () => {
      let count = 0;
      for (const n of notifications) {
        if (n.readAt === null) {
          n.readAt = new Date().toISOString();
          count += 1;
        }
      }
      return count;
    }),
    globalSearch: vi.fn(async (query: string) => {
      const hit = query.includes('2785');
      return {
        query,
        total: hit ? 1 : 0,
        trucks: hit
          ? [
              {
                id: 'trk_2785',
                label: 'Unit 2785',
                secondary: '2022 Freightliner Cascadia · Marcus Reid',
                status: 'active',
                href: '/fleet/trucks/trk_2785',
              },
            ]
          : [],
        trailers: [],
        drivers: [],
        loads: [],
        customers: [],
        brokers: [],
        invoices: [],
        employees: [],
      };
    }),
  };
}
