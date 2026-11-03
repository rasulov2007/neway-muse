import { useState } from 'react';
import { Linking, View, StyleSheet } from 'react-native';

import { api } from '@/api/client';
import { routes, type MyLeadRow, type MyLeads } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { errorText } from '@/features/office/common';
import { inEastern } from '@/lib/clock';
import { humanize } from '@/lib/format';
import { Button, SegmentedTabs } from '@/ui/controls';
import { Panel, Screen, Section, useToast } from '@/ui/layout';
import { Avatar, Icon, StatusPill, Text } from '@/ui/primitives';
import { Pager, ReasonSheet } from '@/ui/sheets';
import { EmptyState, ResourceView } from '@/ui/states';
import { t } from '@/i18n';
import { color, space, type StatusTone } from '@/ui/tokens';

const STATUS: Record<MyLeadRow['status'], { label: string; tone: StatusTone }> = {
  new: { label: 'New', tone: 'warning' },
  contacted: { label: 'Contacted', tone: 'info' },
  prequalified: { label: 'Prequalified', tone: 'moving' },
  converted: { label: 'Converted', tone: 'success' },
  dead: { label: 'Closed', tone: 'neutral' },
};

/** The lead's own progress words (its status only — the candidate journey lives in the TMS). */
const STEPS: Array<{ key: MyLeadRow['status']; label: string }> = [
  { key: 'new', label: 'Lead' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'prequalified', label: 'Prequalified' },
  { key: 'converted', label: 'Applicant' },
];

function Progress({ status }: { status: MyLeadRow['status'] }) {
  const at = STEPS.findIndex((s) => s.key === status);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
      {STEPS.map((s, i) => {
        const done = status !== 'dead' && i < at;
        const current = i === at;
        return (
          <View key={s.key} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch' }}>
              <View style={{ flex: 1, height: 2, backgroundColor: i === 0 ? 'transparent' : done || current ? color.success : color.divider }} />
              {done ? (
                <Icon name="check-circle" size={20} tint={color.success} />
              ) : (
                <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: current ? 5 : 2, borderColor: current ? color.primary : color.borderStrong, backgroundColor: color.background }} />
              )}
              <View style={{ flex: 1, height: 2, backgroundColor: i === STEPS.length - 1 ? 'transparent' : done ? color.success : color.divider }} />
            </View>
            <Text variant="caption" tint={current ? color.ink : color.text2} style={{ textAlign: 'center' }}>
              {t(s.label)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** Sheet 22 — the signed-in recruiter's leads (GET /hiring/my-leads); Call and Add note. */
export default function RecruitingWorkspace() {
  const leads = useResource<MyLeads>(routes.myLeads);
  const [index, setIndex] = useState(0);
  const [noteFor, setNoteFor] = useState<MyLeadRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const addNote = async (lead: MyLeadRow, note: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(routes.leadNotes(lead.id), { note });
      setNoteFor(null);
      toast(t('Note added.'), 'success');
      leads.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen back title={t('Recruiting')} subtitle={t('Find and hire great drivers, faster.')} onRefresh={leads.reload}>
      <SegmentedTabs variant="underline" options={[{ key: 'mine', label: t('My leads') }]} value="mine" onChange={() => undefined} />
      <ResourceView resource={leads} what={t('Your leads')}>
        {(data) => {
          if (!data.recruiter) {
            return <EmptyState icon="account-off-outline" title={t('No leads of your own')} body={t('This account is not linked to an employee, so it has no leads of its own.')} />;
          }
          const rows = data.leads;
          const at = Math.min(index, Math.max(0, rows.length - 1));
          const lead = rows[at];
          return (
            <Section>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.sm }}>
                <Text variant="subheading" style={{ flex: 1 }}>
                  {t('My leads ({count})', { count: rows.length })}
                </Text>
                {rows.length ? <Pager index={at} total={rows.length} onChange={setIndex} /> : null}
              </View>
              {!lead ? (
                <EmptyState compact icon="account-search-outline" title={t('No leads assigned to you')} />
              ) : (
                <Panel style={{ gap: space.md }}>
                  <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start' }}>
                    <Avatar name={lead.name} size={48} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text variant="subheading">{lead.name}</Text>
                      <Text variant="caption" tint={color.text2}>
                        {[lead.phone, humanize(lead.source)].filter(Boolean).join(' • ')}
                      </Text>
                      <Text variant="caption" tint={color.text2}>
                        {lead.leadNumber} · {t('Came in {when}', { when: inEastern(lead.createdAt, true) })}
                      </Text>
                    </View>
                    <StatusPill tone={STATUS[lead.status].tone} label={t(STATUS[lead.status].label)} />
                  </View>
                  <View style={{ flexDirection: 'row', gap: space.md }}>
                    <Button style={{ flex: 1 }} compact variant="outline" icon="phone-outline" label={t('Call')} disabled={!lead.phone} onPress={() => void Linking.openURL(`tel:${lead.phone}`)} />
                    <Button
                      style={{ flex: 1 }}
                      compact
                      variant="outline"
                      icon="note-plus-outline"
                      label={t('Add note')}
                      onPress={() => {
                        setError(null);
                        setNoteFor(lead);
                      }}
                    />
                  </View>
                  <View style={{ gap: space.sm }}>
                    <Text variant="smallStrong">{t('Progress')}</Text>
                    <Progress status={lead.status} />
                  </View>
                  <View style={{ gap: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.divider, paddingTop: space.md }}>
                    <Text variant="smallStrong">{t('Latest activity')}</Text>
                    {lead.lastNote ? (
                      <Text variant="small">
                        <Text variant="caption" tint={color.text2}>
                          {inEastern(lead.lastNote.at, true)}
                          {'  '}
                        </Text>
                        {lead.lastNote.text ?? t('Follow-up')} · {lead.lastNote.byName}
                      </Text>
                    ) : null}
                    {lead.contactedAt ? (
                      <Text variant="caption" tint={color.text2}>
                        {t('Contacted {when}', { when: inEastern(lead.contactedAt, true) })}
                      </Text>
                    ) : null}
                    <Text variant="caption" tint={color.text2}>
                      {t('Lead received {when}', { when: inEastern(lead.createdAt, true) })}
                    </Text>
                  </View>
                </Panel>
              )}
            </Section>
          );
        }}
      </ResourceView>
      <ReasonSheet
        visible={Boolean(noteFor)}
        title={noteFor ? t('Note on {name}', { name: noteFor.name }) : t('Note')}
        label={t('Note')}
        placeholder={t('What happened on the call')}
        confirmLabel={t('Add note')}
        busy={busy}
        error={error}
        onClose={() => setNoteFor(null)}
        onConfirm={(note) => noteFor && void addNote(noteFor, note)}
      />
    </Screen>
  );
}
