import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { proposeDueDate } from '@neway/shared';
import {
  DatePicker,
  Alert,
  Button,
  Checkbox,
  FormField,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from '@/design-system';
import { createDefect } from '@/demo';
import { useInvalidateSafety, useSafety, type SafetyInspection } from '../useSafety';

/**
 * Records one finding against an inspection.
 *
 * "Out of service" is the field that matters most here: setting it parks the unit immediately, and
 * clearing the last such finding on a unit puts it back in dispatch. Both happen through the same
 * write path the roadside would use, so the fleet list and the safety desk cannot disagree.
 */

/** The vehicle systems a CVSA inspection is organised around. */
const COMPONENTS = [
  'Brakes',
  'Tires',
  'Lighting',
  'Suspension',
  'Steering',
  'Coupling',
  'Cargo securement',
  'Exhaust',
  'Fuel system',
  'Frame',
  'Windshield',
  'Wipers',
  'Mirrors',
  'Driver credentials',
  'Hours of service',
  'Other',
];

export function AddFindingDialog({
  open,
  onOpenChange,
  inspection,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inspection: SafetyInspection;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateSafety();
  const safety = useSafety();
  const today = safety.data?.today ?? new Date().toISOString().slice(0, 10);

  const [component, setComponent] = useState('Brakes');
  const [description, setDescription] = useState('');
  const [regulation, setRegulation] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [outOfService, setOutOfService] = useState(false);
  const [dueOn, setDueOn] = useState(proposeDueDate('medium', today));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createDefect({
        inspectionId: inspection.inspection.id,
        assetId: inspection.inspection.assetId,
        severity: severity as 'low' | 'medium' | 'high' | 'critical',
        component,
        description,
        regulation: regulation.trim() ? regulation.trim() : null,
        dueOn,
        outOfService,
        notes: notes.trim() ? notes.trim() : null,
      }),
    onSuccess: async (defect) => {
      await invalidate();
      toast({
        tone: outOfService ? 'warning' : 'success',
        title: `${defect.defectNumber} recorded`,
        description: outOfService
          ? `Unit ${defect.unitNumber} is out of service until this is cleared.`
          : `Repair due ${dueOn}.`,
      });
      onDone();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The finding could not be recorded.'),
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Add finding"
      description={`Against ${inspection.inspection.inspectionNumber} · unit ${inspection.inspection.unitNumber}`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!description.trim()}
            onClick={() => {
              setError(null);
              create.mutate();
            }}
          >
            Add finding
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Component" required>
            <Select
              options={COMPONENTS.map((value) => ({ value, label: value }))}
              value={component}
              onValueChange={setComponent}
            />
          </FormField>
          <FormField label="Severity" required>
            <Select
              options={[
                { value: 'critical', label: 'Critical' },
                { value: 'high', label: 'High' },
                { value: 'medium', label: 'Medium' },
                { value: 'low', label: 'Low' },
              ]}
              value={severity}
              onValueChange={(value) => {
                setSeverity(value);
                setDueOn(proposeDueDate(value, today));
              }}
            />
          </FormField>
        </div>

        <FormField label="What was found" required>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brake adjustment beyond service limit on axle 3, left"
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Regulation" description="The CFR section cited, if there was one.">
            <Input
              value={regulation}
              onChange={(e) => setRegulation(e.target.value)}
              placeholder="393.47(e)"
            />
          </FormField>
          <FormField label="Repair due" description="Proposed from the severity.">
            <DatePicker value={dueOn} onIsoChange={setDueOn} />
          </FormField>
        </div>

        <Checkbox
          checked={outOfService}
          onCheckedChange={(checked) => setOutOfService(checked === true)}
          label="Out-of-service condition"
          description={`Takes unit ${inspection.inspection.unitNumber} out of dispatch until this finding is cleared.`}
        />

        <FormField label="Notes" description="Optional.">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>

        {severity === 'critical' || outOfService ? (
          <Alert
            tone="warning"
            title="Raise a corrective action next"
            description="A finding that stops a unit needs an owner and a date. Create the corrective action from the findings table so it appears in someone's tasks and the queue can report it if it slips."
          />
        ) : null}
      </div>
    </Modal>
  );
}
