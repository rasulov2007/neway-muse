import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import {
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
import { recordInspectionResult } from '@/demo';
import { useInvalidateSafety, type SafetyInspection } from '../useSafety';

/**
 * Records what an inspection found.
 *
 * The out-of-service switch is not cosmetic: setting it takes the unit out of dispatch the same way
 * a roadside officer would, so the fleet list and the safety desk cannot disagree about whether a
 * truck may run. The dialog says so before it is used rather than after.
 */
export function RecordResultDialog({
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

  const [result, setResult] = useState<'pass' | 'fail'>('pass');
  const [outOfService, setOutOfService] = useState(false);
  const [odometer, setOdometer] = useState(String(inspection.inspection.odometer ?? ''));
  const [notes, setNotes] = useState(inspection.inspection.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  const record = useMutation({
    mutationFn: () =>
      recordInspectionResult({
        id: inspection.inspection.id,
        result,
        odometer: odometer ? Number(odometer) : null,
        outOfService,
        notes: notes.trim() ? notes.trim() : null,
      }),
    onSuccess: async (response) => {
      if (!response.ok) {
        setError(response.blocked ?? 'The result could not be recorded.');
        return;
      }
      await invalidate();
      toast({
        tone: result === 'pass' ? 'success' : 'warning',
        title: `${inspection.inspection.inspectionNumber} recorded as ${result}`,
        description: outOfService
          ? `Unit ${inspection.inspection.unitNumber} is out of service until the defects are cleared.`
          : result === 'fail'
            ? 'Add the findings so the corrective actions can be raised.'
            : undefined,
      });
      onDone();
    },
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Record result — ${inspection.inspection.inspectionNumber}`}
      description={`Unit ${inspection.inspection.unitNumber}${
        inspection.inspection.driverName ? ` · ${inspection.inspection.driverName}` : ''
      }`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={record.isPending}
            onClick={() => {
              setError(null);
              record.mutate();
            }}
          >
            Record result
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

        <FormField label="Result" required>
          <Select
            options={[
              { value: 'pass', label: 'Pass' },
              { value: 'fail', label: 'Fail' },
            ]}
            value={result}
            onValueChange={(value) => setResult(value as 'pass' | 'fail')}
          />
        </FormField>

        <FormField label="Odometer" description="As read at the inspection.">
          <Input
            inputMode="numeric"
            value={odometer}
            onChange={(e) => setOdometer(e.target.value)}
          />
        </FormField>

        <Checkbox
          checked={outOfService}
          onCheckedChange={(checked) => setOutOfService(checked === true)}
          label="Unit placed out of service"
          description="Takes the unit out of dispatch immediately, until every out-of-service defect is cleared."
        />

        <FormField label="Notes" description="Optional.">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>

        {result === 'fail' ? (
          <Alert
            tone="info"
            title="Record the findings next"
            description="A failed inspection is not finished work. Add each finding on the inspection page so a corrective action can be raised against it and tracked to a repair."
          />
        ) : null}
      </div>
    </Modal>
  );
}
