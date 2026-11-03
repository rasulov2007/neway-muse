import { useEffect, useState } from 'react';
import { Pressable } from 'react-native';

import type { OfficeRole } from '@/api/contract';
import { useAccount } from '@/auth/session';
import { OFFICE_ROLE_LABEL } from '@neway/shared/mobile/office';
import { draftStore } from '@/offline/db';
import { ListRow, Sheet } from '@/ui/controls';
import { Icon, Text } from '@/ui/primitives';
import { t } from '@/i18n';
import { color, space } from '@/ui/tokens';

const roleLabel = (r: OfficeRole) => t(OFFICE_ROLE_LABEL[r]);

const KEY = 'officeRole';

/**
 * The Today view this person last chose, kept on the phone per company + membership; falls back
 * to the server's best role. Only roles the server lists (todayRoles) are ever offered.
 */
export function useOfficeRole(available: OfficeRole[] | null): [OfficeRole | null, (role: OfficeRole) => void] {
  const account = useAccount();
  const scope = `${account.companyId}:${account.membershipId}`;
  const [stored, setStored] = useState<OfficeRole | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    draftStore
      .get<OfficeRole>(scope, KEY)
      .then((r) => live && setStored(r))
      .catch(() => live && setStored(null));
    return () => {
      live = false;
    };
  }, [scope]);
  const choose = (role: OfficeRole) => {
    setStored(role);
    void draftStore.set(scope, KEY, role).catch(() => undefined);
  };
  if (!available || stored === undefined) return [null, choose];
  const role = stored && available.includes(stored) ? stored : (available[0] ?? null);
  return [role, choose];
}

/** "Dispatcher ⌄" (sheet 13): a plain label when there is only one view. */
export function RolePicker({ role, roles, onChange }: { role: OfficeRole; roles: OfficeRole[]; onChange: (role: OfficeRole) => void }) {
  const [open, setOpen] = useState(false);
  if (roles.length < 2) {
    return (
      <Text variant="smallStrong" style={{ marginTop: 6 }}>
        {roleLabel(role)}
      </Text>
    );
  }
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('View: {role}. Change', { role: roleLabel(role) })}
        onPress={() => setOpen(true)}
        hitSlop={8}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: space.xs, marginTop: 2 }}
      >
        <Text variant="smallStrong">{roleLabel(role)}</Text>
        <Icon name="chevron-down" size={20} tint={color.ink} />
      </Pressable>
      <Sheet visible={open} title={t('Today for')} onClose={() => setOpen(false)}>
        {roles.map((r, i) => (
          <ListRow
            key={r}
            title={roleLabel(r)}
            chevron={false}
            divider={i < roles.length - 1}
            right={r === role ? <Icon name="check" size={22} tint={color.primary} /> : null}
            onPress={() => {
              onChange(r);
              setOpen(false);
            }}
          />
        ))}
      </Sheet>
    </>
  );
}
