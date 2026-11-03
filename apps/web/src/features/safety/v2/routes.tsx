import { useParams, useSearch } from '@tanstack/react-router';
import { isEnabled } from '@/lib/feature-flags';
import { AccidentsBoardPage } from '@/features/accidents/AccidentsBoardPage';
import { CasePage } from '@/features/accidents/CasePage';
import { ClaimsBoardPage } from '@/features/accidents/ClaimsBoardPage';
import { AccidentDetailRoute } from '../AccidentDetailPage';
import { AccidentFormPage } from '../SafetyFormPages';
import { AccidentsPage } from '../AccidentsPage';
import { ClaimDetailRoute } from '../ClaimDetailPage';
import { ClaimsPage } from '../ClaimsPage';
import { CompliancePage } from '../CompliancePage';
import { InspectionsPage } from '../InspectionsPage';
import { SafetyCommandCenterPage } from '../SafetyCommandCenterPage';
import { SafetyReviewQueuePage } from '../SafetyReviewQueuePage';
import { ViolationsPage } from '../ViolationsPage';
import { AccidentDetailV2Page } from './AccidentDetailPage';
import { AccidentsV2Page } from './AccidentsPage';
import { ClaimDetailV2Page } from './ClaimDetailPage';
import { ClaimsV2Page } from './ClaimsPage';
import { ClaimFilePage } from './claims/ClaimFilePage';
import { ClaimsQueuePage } from './claims/ClaimsQueuePage';
import { ComplianceV2Page } from './CompliancePage';
import { InspectionsV2Page } from './InspectionsPage';
import { SafetyOverviewV2Page } from './OverviewPage';
import { SafetyReviewV2Page } from './SafetyReviewPage';
import { ViolationsBoard } from './ViolationsBoard';

/**
 * The switch between the Safety pages production has today and Safety v2 (`safety_v2`).
 *
 * Read once per render from the build's flags: off, every route renders exactly the page it
 * always did; on, the same URL renders the v2 page over the server API. Nothing is deleted.
 */
export const safetyV2 = () => isEnabled('safety_v2');

export function SafetyHomeRoute() {
  return safetyV2() ? <SafetyOverviewV2Page /> : <SafetyCommandCenterPage />;
}

/**
 * Accident & Claims v2 (`accidents_v2`, docs/accidents): when on, the same URLs render the v2 board and case page.
 * Off (the default everywhere), every accident route renders exactly what it did before.
 */
const accidentsV2 = () => isEnabled('accidents_v2');

export function AccidentsRoute() {
  if (accidentsV2()) return <AccidentsBoardPage />;
  return safetyV2() ? <AccidentsV2Page /> : <AccidentsPage />;
}

export function AccidentNewRoute() {
  if (accidentsV2()) return <AccidentsBoardPage startReport />;
  return safetyV2() ? <AccidentsV2Page startRecording /> : <AccidentFormPage />;
}

export function AccidentRoute() {
  const { accidentId } = useParams({ strict: false }) as { accidentId: string };
  if (accidentsV2()) return <CasePage accidentId={accidentId} />;
  return safetyV2() ? <AccidentDetailV2Page accidentId={accidentId} /> : <AccidentDetailRoute />;
}

/** With accidents_v2 the Claims page is the v2 Claims board (one claim per coverage line); the claim file page below keeps
 *  the driver-charge, driver-notice and Accounting-approval flows on the same rows. */
export function ClaimsRoute() {
  if (accidentsV2()) return <ClaimsBoardPage />;
  return safetyV2() ? (isEnabled('claims_v2') ? <ClaimsQueuePage /> : <ClaimsV2Page />) : <ClaimsPage />;
}

export function ClaimRoute() {
  const { claimId } = useParams({ strict: false }) as { claimId: string };
  return safetyV2() ? (isEnabled('claims_v2') ? <ClaimFilePage claimId={claimId} /> : <ClaimDetailV2Page claimId={claimId} />) : <ClaimDetailRoute />;
}

export function ViolationsRoute() {
  return safetyV2() ? <ViolationsBoard /> : <ViolationsPage />;
}

export function InspectionsRoute() {
  return safetyV2() ? <InspectionsV2Page /> : <InspectionsPage />;
}

export function SafetyReviewRoute() {
  return safetyV2() ? <SafetyReviewV2Page /> : <SafetyReviewQueuePage />;
}

/**
 * Compliance: the v2 overview, unless the address asks for the workbench (a tab, an entity or a
 * verification case in the query, as every existing link does). The workbench is never lost.
 */
export function ComplianceRoute() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const wantsWorkbench = ['tab', 'entity', 'case', 'focus', 'state', 'q'].some((k) => search[k] !== undefined);
  return safetyV2() && !wantsWorkbench ? <ComplianceV2Page /> : <CompliancePage />;
}
