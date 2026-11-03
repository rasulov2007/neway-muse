import {
  DOT_APP_ACH_ACCOUNT_TYPES,
  DOT_APP_OPTIONS as OPT,
  dotAppCoverage,
  dotAppDocument,
  dotAppEvEmployers,
  dotAppFcraEntities,
  dotAppSphEmployers,
  evSignatureKey,
  fcraAuthorizationKey,
  fcraDisclosureKey,
  type DotAppEmployer,
} from '@neway/shared';
import { useForm } from './context';
import { Addr, Chk, DocCard, Field, Html, LegalBox, Letterhead, Multi, Note, PendingLegal, Pill, ReadOnly, Rep, YN } from './form';
import { addDays, fmtDate, idOf, maskSsn } from './format';
import { currentLicense, fullName } from './meta';
import { getP, shortId } from './paths';
import { escapeHtml } from './sanitize';
import { Sig } from './signing';

/*
 * The twelve steps, ported field for field from docs/driver-application/prototype.html (STEPS).
 * No legal wording lives here: every document's text, checkbox wording, questions and
 * certifications come from the company's approved template (`f.tpl(key).content`).
 */

const str = (v: unknown) => (typeof v === 'string' ? v : '');
function useDocs() {
  const f = useForm();
  const content = (key: string) => (f.tpl(key)?.content ?? {}) as Record<string, unknown>;
  const ok = (key: string) => Boolean(f.tpl(key)) && !f.awaiting.has(key);
  const title = (key: string) => f.tpl(key)?.title ?? dotAppDocument(key)?.title ?? key;
  const linked = (key: string) => {
    const link = dotAppDocument(key)?.consentLink;
    return link ? f.state.consentLinks.find((l) => l.link === link) ?? null : null;
  };
  return { f, content, ok, title, linked };
}

// ---------------------------------------------------------------------------------------------- 1
export function Personal() {
  const { f, content, ok } = useDocs();
  const a = f.a;
  const opt = content('optins');
  return (
    <>
      {f.prefilled.size ? <Note kind="ok">Some details were filled in from the Consent Form you already signed. Please check them and update anything that changed.</Note> : null}
      {ok('intelliapp_intro') ? (
        <details className="doc" style={{ padding: '14px 18px' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>About this application &amp; EEO statement</summary>
          {content('intelliapp_intro').letterhead ? <Letterhead /> : null}
          <Html as="div" className="legal-inline" html={content('intelliapp_intro').html} />
        </details>
      ) : null}
      <div className="grid">
        <Field path="personal.firstName" label="First name" req ac="given-name" />
        <Field path="personal.middleName" label="Middle name" ac="additional-name" />
        <Field path="personal.lastName" label="Last name" req ac="family-name" />
        <Field path="personal.suffix" label="Suffix" opts={OPT.suffix} ph="None" />
        <Addr base="personal.address" country />
        <YN path="personal.res3" q="Residence 3 years or longer (If No, previous addresses shown below)" />
        {a.personal?.res3 === 'No' ? (
          <div className="full">
            <h2 className="blk">Previous addresses</h2>
            <p className="blk-sub">List every address for the past 3 years.</p>
            <Rep
              path="personal.prevAddresses"
              title="Previous address"
              min={1}
              add="Add another address"
              make={() => ({ country: 'United States' })}
              item={(p) => (
                <>
                  <Addr base={p} country />
                  <Field path={`${p}.from`} label="From" type="date" req max={f.today} />
                  <Field path={`${p}.to`} label="To" type="date" req max={f.today} />
                </>
              )}
            />
          </div>
        ) : null}
        <SsnField />
        <Field path="personal.dob" label="Date of Birth" type="date" req max={f.today} ac="bday" />
        <Field path="personal.phone" label="Primary Phone" type="tel" req im="tel" ac="tel" err="Enter a 10-digit phone number." />
        <Field path="personal.email" label="Email" type="email" req ac="email" err="Enter a valid email address." />
        {ok('optins') ? (
          <div className="full chk-list">
            <Chk path="personal.emailOptIn" html={opt.email_optin} />
            <YN path="personal.smsOptIn" q={<Html html={opt.sms_optin_q} />} req={false} />
            <Html as="div" className="hint" html={opt.sms_optin_terms} />
          </div>
        ) : null}
      </div>
    </>
  );
}

/** SSN (prototype SSN()): masked "On file" with Change; never kept in the answers. */
function SsnField() {
  const f = useForm();
  const s = f.ssn;
  const id = idOf('personal.ssn');
  const invalid = f.errors.has('personal.ssn');
  if (s.onFile && !s.editing)
    return (
      <div className="f" data-key="personal.ssn">
        <label className="lbl" htmlFor={id}>
          SSN/SIN
          <span className="req" aria-hidden="true">
            *
          </span>
          <span className="prefill">On file</span>
        </label>
        <div className="inp-row">
          <input className="inp" id={id} value={maskSsn(s.last4)} readOnly aria-label="SSN/SIN (masked)" />
          <button type="button" className="btn btn-ghost" onClick={s.startEdit}>
            Change
          </button>
        </div>
        <div className="hint">Stored encrypted. Only authorized Safety staff can view the full number.</div>
      </div>
    );
  const digits = s.draft.replace(/\D/g, '');
  return (
    <div className={`f${invalid ? ' invalid' : ''}`} data-key="personal.ssn">
      <label htmlFor={id}>
        SSN/SIN
        <span className="req" aria-hidden="true">
          *
        </span>
      </label>
      <input
        className="inp"
        id={id}
        value={s.draft}
        placeholder="XXX-XX-XXXX"
        inputMode="numeric"
        autoComplete="off"
        aria-required
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}_e`}
        onChange={(e) => {
          const dg = e.target.value.replace(/\D/g, '').slice(0, 9);
          s.setDraft(dg.length > 5 ? `${dg.slice(0, 3)}-${dg.slice(3, 5)}-${dg.slice(5)}` : dg.length > 3 ? `${dg.slice(0, 3)}-${dg.slice(3)}` : dg);
        }}
      />
      <div className="err-msg" id={`${id}_e`}>
        {digits.length ? 'Enter a 9-digit SSN (XXX-XX-XXXX).' : 'This field is required.'}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- 2
export function Company() {
  const f = useForm();
  const c = f.a.company ?? {};
  return (
    <>
      <h2 className="blk">General information</h2>
      <div className="grid">
        <Field path="company.position" label="What position are you applying for?" req opts={OPT.position} />
        <Field path="company.location" label="What location are you applying for?" req opts={f.company.locations} />
        <YN path="company.isOwner" q={'If you answered "Owner Operator" or "Fleet Owner", select yes.'} />
      </div>
      {c.isOwner === 'Yes' ? (
        <>
          <h2 className="blk">Equipment (Owner/Operators only)</h2>
          <p className="blk-sub">Equipment Description (Tractor):</p>
          <Rep
            path="company.equipment"
            title="Tractor"
            min={1}
            add="Add another tractor"
            item={(p) => (
              <>
                <Field path={`${p}.type`} label="Type" req />
                <Field path={`${p}.year`} label="Year" req im="numeric" />
                <Field path={`${p}.make`} label="Make" req />
                <Field path={`${p}.model`} label="Model" req />
                <Field path={`${p}.color`} label="Color" />
                <Field path={`${p}.vin`} label="VIN" req err="VIN must be 17 characters." />
                <Field path={`${p}.weight`} label="Weight" im="numeric" />
                <Field path={`${p}.mileage`} label="Mileage" im="numeric" />
                <Field path={`${p}.fifth`} label="Fifth Wheel Height" />
              </>
            )}
          />
        </>
      ) : null}
      <div className="grid" style={{ marginTop: 8 }}>
        <YN path="company.eligible" q="Are you legally eligible for employment in the United States?" />
        <YN path="company.employed" q="Are you currently employed?" />
        {c.employed === 'No' ? <Field path="company.lastEnd" label="What date did your last employment end?" type="date" req max={f.today} /> : null}
        <YN path="company.english" q="Do you read, write, and speak English?" />
        <YN path="company.workedBefore" q="Have you ever worked for this company before?" />
        {c.workedBefore === 'Yes' ? <Field path="company.workedBeforeDetails" label="Enter start and end dates, location, position, and reason for leaving:" type="textarea" req full /> : null}
        <YN path="company.twic" q="Do you have a current TWIC card?" />
        {c.twic === 'Yes' ? <Field path="company.twicExp" label="Expiration date:" type="date" req /> : null}
        <YN path="company.otherName" q="Have you ever been known by any other name?" />
        {c.otherName === 'Yes' ? <Field path="company.otherNameText" label="Enter name:" req /> : null}
        <Field path="company.heard" label="How did you hear about us?" req opts={OPT.heard} />
        {c.heard === 'Driver Referral' ? <Field path="company.referral" label={'If "Driver Referral", please enter the driver\'s name'} req /> : null}
        {c.heard === 'Other' ? <Field path="company.heardOther" label={'If "Other", please explain'} req /> : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------- 3
export function License() {
  return (
    <>
      <h2 className="blk">Driving experience</h2>
      <p className="blk-sub">For each class of equipment, select years of experience. If no experience in a class, select "None".</p>
      <div className="grid">
        <Field path="exp.straight" label="Straight Truck" req opts={OPT.yearsExp} />
        <Field path="exp.tractorSemi" label="Tractor and Semi-Trailer" req opts={OPT.yearsExp} />
        <Field path="exp.twoTrailers" label="Tractor - Two Trailers" req opts={OPT.yearsExp} />
        <Field path="exp.other" label="Other" req opts={OPT.yearsExp} />
      </div>
      <h2 className="blk" style={{ marginTop: 30 }}>
        Licenses
      </h2>
      <p className="blk-sub">List every license held. Mark the one you currently hold as "Current License".</p>
      <Rep
        path="licenses"
        title="License"
        min={1}
        add="Add another license"
        item={(p, i) => (
          <>
            <Field path={`${p}.number`} label="License Number" req />
            <Field path={`${p}.authority`} label="Licensing Authority" req opts={OPT.states} />
            <Field path={`${p}.country`} label="Country" req opts={OPT.country} />
            <Field path={`${p}.cls`} label="License Class" req opts={OPT.licClass} />
            <Field path={`${p}.exp`} label="License Expiration Date" type="date" req />
            <Field path={`${p}.med`} label="DOT Medical Card Expiration Date" type="date" req={i === 0} />
            <YN path={`${p}.current`} q="Current License" />
            <YN path={`${p}.cdl`} q="Commercial Driver License" />
            <Multi path={`${p}.endorse`} label="Endorsements" opts={OPT.endorse} />
          </>
        )}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------- 4
export function Employment() {
  const f = useForm();
  const cov = dotAppCoverage(f.a, f.today);
  return (
    <>
      <Note kind={cov.ok ? 'ok' : 'info'}>
        <b>Past 3 years: {cov.months} of 36 months accounted for.</b> Include employers and periods of unemployment so there are no gaps.
        {cov.gaps.length ? (
          <>
            <br />
            Gaps: {cov.gaps.map((g) => `${fmtDate(g[0])} – ${g[1] ? fmtDate(g[1]) : fmtDate(f.today)}`).join(', ')}
          </>
        ) : null}
      </Note>
      <h2 className="blk">Employers</h2>
      <Rep
        path="employers"
        title="Employer"
        min={1}
        add="Add another employer"
        make={() => ({ id: shortId(), address: { country: 'United States' } })}
        item={(p) => {
          const e = (getP(f.a, p) ?? {}) as DotAppEmployer;
          const cur = e.current === 'Yes';
          return (
            <>
              <Field path={`${p}.company`} label="Company" req full />
              <Field path={`${p}.start`} label="Start Date" type="date" req max={f.today} />
              <Field path={`${p}.end`} label="End Date" type="date" req={!cur} max={f.today} hint={cur ? 'Leave blank for current employer.' : undefined} />
              <Addr base={`${p}.address`} country />
              <Field path={`${p}.address.street2`} label="Address 2" full />
              <Field path={`${p}.phone`} label="Phone" type="tel" req im="tel" />
              <Field path={`${p}.fax`} label="Fax" type="tel" im="tel" />
              <Field path={`${p}.position`} label="Position Held" req />
              <Field path={`${p}.reason`} label="Reason for leaving?" req={!cur} />
              <YN path={`${p}.terminated`} q="Were you terminated/discharged/laid off?" />
              <YN path={`${p}.current`} q="Is this your current employer?" />
              <YN path={`${p}.contact`} q="May we contact this employer at this time?" />
              <YN path={`${p}.cmv`} q="Did you operate a commercial motor vehicle?" />
              <YN path={`${p}.fmcsr`} q="Were you subject to the US Federal Motor Carrier Safety Administration (FMCSA) or Transport Canada Safety Regulations while employed/contracted by this employer/contractor?" />
              <YN path={`${p}.dotTesting`} q="Did you perform any safety sensitive functions in this job, regulated by DOT, and subject to drug and alcohol testing?" />
              {e.cmv === 'Yes' ? (
                <>
                  <Multi path={`${p}.areas`} label="Areas Driven" opts={OPT.areas} req />
                  <Field path={`${p}.miles`} label="Miles driven weekly" im="numeric" req />
                  <Field path={`${p}.truck`} label="Most common truck driven" opts={OPT.truck} req />
                  <Field path={`${p}.trailer`} label="Most common trailer" opts={OPT.trailer} req />
                  <Field path={`${p}.trailerLen`} label="Trailer length" opts={OPT.trailerLen} req />
                </>
              ) : null}
            </>
          );
        }}
      />
      <h2 className="blk" style={{ marginTop: 30 }}>
        Unemployment
      </h2>
      <p className="blk-sub">Add any period you were not employed.</p>
      <Rep
        path="unemployment"
        title="Unemployment period"
        add="Add unemployment period"
        item={(p) => (
          <>
            <Field path={`${p}.start`} label="Start Date" type="date" req max={f.today} />
            <Field path={`${p}.end`} label="End Date" type="date" req max={f.today} />
            <Field path={`${p}.comment`} label="Comment" type="textarea" full />
          </>
        )}
      />
      <h2 className="blk" style={{ marginTop: 30 }}>
        Trucking school
      </h2>
      <Rep
        path="schools"
        title="Trucking school"
        add="Add trucking school"
        make={() => ({ id: shortId() })}
        item={(p) => (
          <>
            <Field path={`${p}.start`} label="Start Date" type="date" req />
            <Field path={`${p}.end`} label="End Date" type="date" req />
            <Field path={`${p}.school`} label="School" req full />
            <Field path={`${p}.address`} label="Address" full />
            <Field path={`${p}.address2`} label="Address 2" full />
            <Field path={`${p}.city`} label="City, State/Province" />
            <Field path={`${p}.country`} label="Country" opts={OPT.country} />
            <Field path={`${p}.phone`} label="Phone" type="tel" im="tel" />
            <Field path={`${p}.gpa`} label="GPA" />
            <Field path={`${p}.hours`} label="Hours of Instruction" im="numeric" />
            <YN path={`${p}.graduated`} q="Did you graduate?" />
            <YN path={`${p}.fmcsr`} q="Were you subject to the Federal Motor Carrier or Transport Canada Safety Regulations while attending this truck school?" />
            <YN path={`${p}.dotTesting`} q="Did you perform any safety sensitive functions at this truck school, regulated by DOT, and subject to drug and alcohol testing?" />
            <Multi path={`${p}.subjects`} label="Subjects covered" opts={OPT.schoolSubjects} />
          </>
        )}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------- 5
export function History() {
  const f = useForm();
  const a = f.a;
  const anyYes = Object.values(a.criminal ?? {}).includes('Yes');
  return (
    <>
      <h2 className="blk">FMCSR</h2>
      <YN path="fmcsr.disqualified" q="Under FMCSR 391.15, are you currently disqualified from driving a commercial motor vehicle?" cite="[49 CFR 391.15]" />
      <YN path="fmcsr.suspended" q="Has your license, permit or privilege to drive ever been suspended or revoked for any reason?" cite="[49 CFR 391.21(b)(9)]" />
      <YN path="fmcsr.denied" q="Have you ever been denied a license, permit, or privilege to operate a motor vehicle?" cite="[49 CFR 391.21(b)(9)]" />
      <YN
        path="fmcsr.preEmpPositive"
        q="Within the past two years, have you tested positive, or refused to test, on a pre-employment drug or alcohol test by an employer to whom you applied, but did not obtain, safety-sensitive transportation work covered by DOT agency drug and alcohol testing rules?"
        cite="[49 CFR 40.25(j)]"
      />
      <YN
        path="fmcsr.convicted"
        q={
          <>
            In the past three(3) years, have you ever been convicted of any of the following offenses: <span className="cite">[49 CFR 391.15]</span>:
            <ul style={{ fontWeight: 500, margin: '8px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.55 }}>
              <li>Driving a commercial motor vehicle with a blood alcohol concentration ("BAC") of .04 percent or more</li>
              <li>Driving under the influence of alcohol, as prescribed by state law</li>
              <li>Refusal to undergo drug and alcohol testing as required by any jurisdiction for the enforcement of Federal Motor Carrier Safety Act regulations</li>
              <li>
                Driving a commercial motor vehicle under the influence of any 21 C.F.R. 1308.11 Schedule I identified controlled substance, an amphetamine, a narcotic drug, a formulation of an amphetamine, or a
                derivative of a narcotic drug
              </li>
              <li>
                Transportation, possession, or unlawful use of a 21 C.F.R. 1308.11 Schedule I identified controlled substance, amphetamines, narcotic drugs, formulations of an amphetamine, or derivatives of
                narcotic drugs while you were on duty driving for a motor carrier
              </li>
              <li>Leaving the scene of an accident while operating a commercial motor vehicle</li>
              <li>Or any other felony involving the use of a commercial motor vehicle</li>
            </ul>
          </>
        }
      />
      <h2 className="blk" style={{ marginTop: 28 }}>
        Vehicle accident record
      </h2>
      <YN path="accidents.any" q="Were you involved in any accidents/incidents with any vehicle in the last 5 years (even if not at fault)?" opts={['Yes', 'No Accidents']} />
      {a.accidents?.any === 'Yes' ? (
        <Rep
          path="accidents.list"
          title="Accident"
          min={1}
          add="Add another accident"
          item={(p) => (
            <>
              <Field path={`${p}.date`} label="Date" type="date" req max={f.today} />
              <Field path={`${p}.location`} label="Location (City, State)" req />
              <Field path={`${p}.injuries`} label="No. of Injuries" type="number" min="0" req im="numeric" />
              <Field path={`${p}.fatalities`} label="No. of Fatalities" type="number" min="0" req im="numeric" />
              <YN path={`${p}.hazmat`} q="Hazmat Spill" />
              <YN path={`${p}.cmv`} q="In Commercial Vehicle" />
              <Field path={`${p}.desc`} label="Description" type="textarea" full />
            </>
          )}
        />
      ) : null}
      <h2 className="blk" style={{ marginTop: 28 }}>
        Traffic convictions \ violations
      </h2>
      <YN path="violations.any" q="Have you had any moving violations or traffic convictions in the past 3 years?" />
      {a.violations?.any === 'Yes' ? (
        <Rep
          path="violations.list"
          title="Violation"
          min={1}
          add="Add another violation"
          item={(p) => (
            <>
              <Field path={`${p}.date`} label="Violation Date" type="date" req max={f.today} />
              <Field path={`${p}.state`} label="Violation State/Province" req opts={OPT.states} />
              <Field path={`${p}.charge`} label="Charge / Description" req full />
              <Field path={`${p}.mph`} label="MPH Over Limit:" type="number" im="numeric" min="0" />
              <Field path={`${p}.fine`} label="Fine Amount (if any):" im="decimal" />
              <YN path={`${p}.cmv`} q="In Commercial Vehicle" />
              <YN path={`${p}.fined`} q="Fined?" />
              <YN path={`${p}.suspended`} q="License Suspended?" />
              <YN path={`${p}.revoked`} q="License Revoked?" />
              <YN path={`${p}.community`} q="Perform Community Service?" />
              <YN path={`${p}.otherPenalty`} q="Other Penalty?" />
              <Field path={`${p}.comments`} label="Comments:" type="textarea" full />
            </>
          )}
        />
      ) : null}
      <h2 className="blk" style={{ marginTop: 28 }}>
        Criminal record
      </h2>
      <YN path="criminal.convicted" q="Have you ever been convicted of a crime?" />
      <YN path="criminal.deferred" q="Do you have any deferred prosecutions?" />
      <YN path="criminal.pending" q="Do you have criminal charges pending?" />
      <YN path="criminal.felony" q={'Have you ever pled "guilty" to, been convicted of, or pled "no contest" to a felony?'} />
      <YN path="criminal.canadaPermit" q="If you have any felony convictions, do you currently hold a minister's permit to enter or exit Canada?" />
      <YN
        path="criminal.misdemeanor"
        q={'Have you, within the last five years, pled "guilty" to, been convicted of, had prosecution deferred in connection with, or pled "no contest" to a misdemeanor?'}
      />
      {anyYes ? (
        <div className="grid">
          <Field path="criminal.explain" label="Please explain (optional)" type="textarea" full />
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- 6
export function Emergency() {
  const { f, content, ok, title } = useDocs();
  const em = f.a.emergency ?? {};
  const c = content('emergency');
  return (
    <>
      <div className="grid">
        <ReadOnly label="Company Name" value={f.company.legalName} />
        <div className="f">
          <ReadOnly label="Position" value={f.a.company?.position ?? ''} />
          <div className="hint">From your answer in Company questions.</div>
        </div>
      </div>
      <p className="hint" style={{ margin: '10px 0 0' }}>
        Employee Full Name, Social Security Number, Home Address, Home Phone and Date of Birth are taken from Personal information.
      </p>
      <h2 className="blk" style={{ marginTop: 24 }}>
        Emergency Contact #1 (required)
      </h2>
      <div className="grid">
        <Field path="emergency.c1.name" label="Name" req />
        <Field path="emergency.c1.relationship" label="Relationship" req />
        <Field path="emergency.c1.address" label="Address" req full />
        <Field path="emergency.c1.csz" label="City, State, Zip" req full />
        <Field path="emergency.c1.phone" label="Phone Number" type="tel" im="tel" req err="Enter a 10-digit phone number." />
        <Field path="emergency.c1.alt" label="Alt. Number" type="tel" im="tel" />
      </div>
      <h2 className="blk" style={{ marginTop: 24 }}>
        Emergency Contact #2 (optional)
      </h2>
      <div className="grid">
        <Field path="emergency.c2.name" label="Name" />
        <Field path="emergency.c2.relationship" label="Relationship" />
        <Field path="emergency.c2.address" label="Address" full />
        <Field path="emergency.c2.csz" label="City, State, Zip" full />
        <Field path="emergency.c2.phone" label="Phone Number" type="tel" im="tel" />
        <Field path="emergency.c2.alt" label="Alt. Number" type="tel" im="tel" />
      </div>
      {ok('emergency') && str(c.optional) ? (
        <h2 className="blk" style={{ marginTop: 24 }}>
          <Html html={c.optional} />
        </h2>
      ) : (
        <div style={{ marginTop: 24 }} />
      )}
      <YN path="emergency.allergies" q="Any allergies?" req={false} />
      {em.allergies === 'Yes' ? (
        <div className="grid">
          <Field path="emergency.allergiesList" label="If yes, please list:" type="textarea" full />
        </div>
      ) : null}
      <YN path="emergency.health" q="Any special health conditions?" req={false} />
      {em.health === 'Yes' ? (
        <div className="grid">
          <Field path="emergency.healthList" label="If yes, please list:" type="textarea" full />
        </div>
      ) : null}
      <div className="grid" style={{ marginTop: 12 }}>
        <Field path="emergency.physician" label="Physician: Name" />
        <Field path="emergency.physicianPhone" label="Phone" type="tel" im="tel" />
      </div>
      {ok('emergency') ? (
        <>
          {str(c.confidential) ? <Html as="p" className="hint" html={c.confidential} /> : null}
          <Sig k="emergency" label="Employee’s Signature" />
        </>
      ) : (
        <div style={{ marginTop: 16 }}>
          <PendingLegal names={[title('emergency')]} />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- 7
export function Certs() {
  const { f, content, ok, title } = useDocs();
  const a = f.a;
  const lic = currentLicense(a);
  const yearAgo = addDays(f.today, -365);
  const v12 = (a.violations?.list ?? []).filter((x) => x.date && x.date > yearAgo);
  const lc = content('license_compliance');
  const vc = content('violations_cert');
  const pd = content('prev_da');
  const od = content('onduty');
  const ow = content('other_work');
  const total = [1, 2, 3, 4, 5, 6, 7].reduce((s, n) => s + (Number(getP(a, `onduty.h${n}`)) || 0), 0);
  const pending = (key: string) => (
    <DocCard title={title(key)}>
      <PendingLegal names={[title(key)]} />
    </DocCard>
  );
  return (
    <>
      {ok('license_compliance') ? (
        <DocCard title={title('license_compliance')}>
          <LegalBox html={lc.html} id="lc" />
          <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 10px' }}>The following license is the only one I will possess:</p>
          <div className="grid g3">
            <ReadOnly label="Driver’s License No." value={lic.number || '—'} />
            <ReadOnly label="State" value={lic.authority || '—'} />
            <ReadOnly label="Exp. Date" value={fmtDate(lic.exp)} />
          </div>
          <p className="hint" style={{ margin: '8px 0 12px' }}>
            From your Current License.{' '}
            <button type="button" className="link-btn" onClick={() => f.goto('license')}>
              Edit
            </button>
          </p>
          <Html as="p" html={lc.certify} />
          <Sig k="license_compliance" label="Driver’s Signature" />
        </DocCard>
      ) : (
        pending('license_compliance')
      )}

      {ok('violations_cert') ? (
        <DocCard title={title('violations_cert')} pill={<Pill k="info">Driver section only</Pill>}>
          <LegalBox html={vc.html} id="vc" />
          <div className="grid g3" style={{ marginBottom: 12 }}>
            <ReadOnly label="Name of Driver" value={fullName(a) || '—'} />
            <ReadOnly label="Social Security Number" value={maskSsn(f.ssn.last4) || '—'} />
            <ReadOnly label="Driver License Number" value={lic.number || '—'} />
            <ReadOnly label="State" value={lic.authority || '—'} />
            <ReadOnly label="Expiration Date" value={fmtDate(lic.exp)} />
          </div>
          <Html as="p" html={vc.certify} />
          <Chk path="cov.none" html={vc.none} />
          {a.cov?.none ? null : (
            <div style={{ marginTop: 14 }}>
              {v12.length ? <p className="hint">{v12.length} violation(s) from the last 12 months copied from your Safety record. Add the type of vehicle operated.</p> : null}
              <Rep
                path="cov.list"
                title="Violation (past 12 months)"
                add="Add violation"
                item={(p) => (
                  <>
                    <Field path={`${p}.date`} label="Date" type="date" req max={f.today} />
                    <Field path={`${p}.offense`} label="Offense" req />
                    <Field path={`${p}.location`} label="Location" req />
                    <Field path={`${p}.vehicle`} label="Type of Vehicle Operated" req />
                  </>
                )}
              />
              {v12.length && !(a.cov?.list ?? []).length ? (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  style={{ marginTop: 10 }}
                  onClick={() =>
                    f.set(
                      'cov.list',
                      v12.map((x) => ({ date: x.date, offense: x.charge, location: x.state, vehicle: x.cmv === 'Yes' ? 'Commercial motor vehicle' : '' })),
                    )
                  }
                >
                  Copy {v12.length} from Safety record
                </button>
              ) : null}
            </div>
          )}
          <Html as="p" className="hint" html={vc.noneCert} />
          <p className="hint">Home Terminal and Date of Employment are completed by the motor carrier at hire.</p>
          <Sig k="violations_cert" label="Driver’s Signature" note="Date of Certification is recorded automatically." />
        </DocCard>
      ) : (
        pending('violations_cert')
      )}

      {ok('prev_da') ? (
        <DocCard title={title('prev_da')}>
          <LegalBox html={pd.html} id="pd" />
          <YN path="prevda.q1" q={<Html html={pd.q1} />} />
          {a.prevda?.q1 === 'Yes' ? <YN path="prevda.q2" q={<Html html={pd.q2} />} /> : null}
          {a.prevda?.q1 && a.fmcsr?.preEmpPositive && (a.prevda.q1 === 'Yes') !== (a.fmcsr.preEmpPositive === 'Yes') ? (
            <Note kind="warn">
              This answer differs from your FMCSR answer (past <b>two</b> years). Both questions are kept as written; please check both are correct.
            </Note>
          ) : null}
          <Html as="p" html={pd.certify} />
          <Sig k="prev_da" label="Prospective Employee’s Signature" />
        </DocCard>
      ) : (
        pending('prev_da')
      )}

      {ok('onduty') ? (
        <DocCard title={title('onduty')}>
          <LegalBox html={od.html} id="od" />
          <div className="grid" style={{ marginBottom: 12 }}>
            <ReadOnly label="Driver’s Name" value={fullName(a) || '—'} />
            <ReadOnly label="Social Security Number" value={maskSsn(f.ssn.last4) || '—'} />
          </div>
          <div className="grid g3" style={{ marginBottom: 12 }}>
            <ReadOnly label="Driver’s License: State" value={lic.authority || '—'} />
            <ReadOnly label="Number" value={lic.number || '—'} />
            <ReadOnly label="Class" value={lic.cls || '—'} />
          </div>
          <div className="grid">
            <Field path="onduty.end" label="End:" />
            <Field path="onduty.rest" label="Rest:" />
          </div>
          <div className="tbl-wrap" style={{ margin: '14px 0' }}>
            <table className="tbl" style={{ border: '1px solid var(--border-soft)', borderRadius: 10 }}>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Date</th>
                  <th>Total Hours Worked</th>
                </tr>
              </thead>
              <tbody>
                {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                  <OnDutyRow key={n} n={n} />
                ))}
                <tr>
                  <td colSpan={2}>
                    <b>Total</b>
                  </td>
                  <td>
                    <b>{total.toFixed(2)}</b>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <Html as="p" html={od.certify} />
          <div className="grid">
            <Field path="onduty.relievedTime" label="Time" type="time" req />
            <Field path="onduty.relievedDate" label="On (Date)" type="date" req max={f.today} />
          </div>
          <Sig k="onduty" label="Driver’s Signature" />
        </DocCard>
      ) : (
        pending('onduty')
      )}

      {ok('other_work') ? (
        <DocCard title={title('other_work')}>
          <LegalBox html={ow.html} id="ow" />
          <YN path="otherwork.q1" q={<Html html={ow.q1} />} />
          <YN path="otherwork.q2" q={<Html html={ow.q2} />} />
          <Html as="p" html={ow.certify} />
          <Sig k="other_work" label="Driver’s Signature" />
        </DocCard>
      ) : (
        pending('other_work')
      )}
    </>
  );
}

function OnDutyRow({ n }: { n: number }) {
  const f = useForm();
  const path = `onduty.h${n}`;
  const val = getP(f.a, path);
  const invalid = f.errors.has(path);
  return (
    <tr>
      <td>
        {n}
        {n === 1 ? ' (Yesterday)' : ''}
      </td>
      <td>{fmtDate(addDays(f.today, -n))}</td>
      <td style={{ minWidth: 110 }}>
        <div className={`f${invalid ? ' invalid' : ''}`} data-key={path}>
          <input
            className="inp"
            type="number"
            min="0"
            max="24"
            step="0.25"
            inputMode="decimal"
            value={val == null ? '' : String(val)}
            aria-label={`Hours worked day ${n}`}
            aria-invalid={invalid || undefined}
            onChange={(e) => f.set(path, e.target.value)}
          />
          <div className="err-msg">Required (enter 0 if none)</div>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------------------------- 8
const DISCLOSURE_DOCS = ['fcra_summary', 'ny23a', 'psp', 'fcra_disclosure', 'fcra_authorization', 'emp_verification', 'clearinghouse_ongoing', 'fcra_1681m', 'icr'] as const;

export function Disclosures() {
  const { f, content, ok, title, linked } = useDocs();
  const a = f.a;
  const all = [...DISCLOSURE_DOCS, 'sph_request', 'clearinghouse_single'];
  if (all.every((k) => !ok(k))) return <PendingLegal names={all.map(title)} />;
  const sph = dotAppSphEmployers(a, f.today);
  const ev = dotAppEvEmployers(a, f.today);
  const first = f.state.consentLinks[0];
  const sphC = content('sph_request');
  const chsLinked = linked('clearinghouse_single');
  return (
    <>
      {first ? (
        <Note kind="info">
          <b>Consent Form on file</b> — signed {fmtDate(first.signedAt)}, version {first.version}, reviewed by Safety. {f.state.consentLinks.map((l) => l.title).join(', ')} from that record{' '}
          {f.state.consentLinks.length > 1 ? 'are' : 'is'} linked below.
        </Note>
      ) : null}
      {DISCLOSURE_DOCS.map((key) => {
        if (!ok(key))
          return (
            <DocCard key={key} title={title(key)}>
              <PendingLegal names={[title(key)]} />
            </DocCard>
          );
        const L = content(key);
        const link = linked(key);
        const captures = Array.isArray(L.captures) ? (L.captures as string[]) : [];
        const card = (
          <DocCard key={key} title={title(key)} pill={link ? <Pill k="ok">Linked to Consent Form</Pill> : key === 'emp_verification' && ev.length ? <Pill k="info">{`${ev.length} employer${ev.length === 1 ? '' : 's'}`}</Pill> : undefined}>
            {link ? (
              <Note kind="ok">
                You signed the {link.title} in your Consent Form on {fmtDate(link.signedAt)}. No new signature is collected here.
              </Note>
            ) : null}
            <LegalBox html={L.html} id={key} />
            <Chk path={`ack.${key}`} html={L.check} req />
            {key === 'emp_verification' && ev.length ? (
              <>
                <p className="hint" style={{ marginTop: 10 }}>
                  One request per previous employer of the last 3 years, each signed separately. Built from your Employment history.
                </p>
                {ev.map((e) => (
                  <div className="rep" key={e.id}>
                    <div className="rep-h">
                      <b>{e.company}</b>
                      <span className="pill mute">
                        {fmtDate(e.start)} – {e.end ? fmtDate(e.end) : 'Present'}
                      </span>
                    </div>
                    <p style={{ fontSize: 13, margin: '0 0 4px' }}>{str(L.authorizeLead) || 'I, the above mentioned signer, hereby authorize'}</p>
                    <div className="auth-boxes" data-testid={`ev-boxes-${e.id}`}>
                      <span>{e.company}</span>
                      <span>{[e.address?.city, e.address?.state].filter(Boolean).join(', ') || e.phone || ''}</span>
                    </div>
                    <div className="grid g3">
                      <ReadOnly label="Date" value={fmtDate(f.today)} />
                      <ReadOnly label="Social Security Number" value={maskSsn(f.ssn.last4) || '—'} />
                      <ReadOnly label="Print Name (First, MI, Last)" value={fullName(a, true) || '—'} />
                    </div>
                    <Sig k={evSignatureKey(e.id)} label="Signature" />
                  </div>
                ))}
              </>
            ) : !link && f.required.has(key) ? (
              <Sig k={key} label="Signature" note={captures.length ? `Records: ${captures.join(', ')}` : ''} />
            ) : null}
          </DocCard>
        );
        return key === 'fcra_authorization' ? [card, <FcraEntities key="fcra-entities" />] : card;
      })}
      {ok('sph_request') ? (
        <DocCard title={title('sph_request')} pill={<Pill k="info">{`${sph.length} employer${sph.length === 1 ? '' : 's'}`}</Pill>}>
          <LegalBox html={sphC.html} id="sph" />
          <p className="hint">One request per previous employer from the last 3 years where you performed DOT-tested safety-sensitive work. Built from your Employment history.</p>
          {sph.length ? (
            sph.map((e) => (
              <div className="rep" key={e.id}>
                <div className="rep-h">
                  <b>{e.company}</b>
                  <span className="pill mute">
                    {fmtDate(e.start)} – {e.end ? fmtDate(e.end) : 'Present'}
                  </span>
                </div>
                <Html
                  as="p"
                  className="sph-s1"
                  html={`I, ${escapeHtml(fullName(a, true))} (${escapeHtml(maskSsn(f.ssn.last4))}, DOB ${escapeHtml(fmtDate(a.personal?.dob))}) ${str(sphC.s1)
                    .replace('[Previous Employer]', `<b>${escapeHtml(e.company)}</b>`)
                    .replace('[date of employment application]', `<b>${escapeHtml(fmtDate(f.today))}</b>`)}`}
                />
                <div className="grid">
                  <Field path={`sph.${e.id}.email`} label="Previous Employer Email" type="email" />
                  <Field path={`sph.${e.id}.fax`} label="Fax No." type="tel" />
                </div>
                <p className="hint" style={{ marginTop: 10 }}>
                  <Html html={sphC.to} />
                  <br />
                  <Html html={f.company.sphConfidentialFax ? str(sphC.conf).replace(/_{3,}/, escapeHtml(f.company.sphConfidentialFax)) : sphC.conf} />
                </p>
                <Sig k={`sph_${e.id}`} label="Signature" />
              </div>
            ))
          ) : (
            <Note kind="info">No previous employer in the last 3 years is marked as DOT drug &amp; alcohol tested. If that is wrong, update Employment history.</Note>
          )}
        </DocCard>
      ) : (
        <DocCard title={title('sph_request')}>
          <PendingLegal names={[title('sph_request')]} />
        </DocCard>
      )}
      {ok('clearinghouse_single') ? (
        <DocCard title={title('clearinghouse_single')} pill={chsLinked ? <Pill k="ok">Linked to Consent Form</Pill> : undefined}>
          {chsLinked ? <Note kind="ok">Covered by the Clearinghouse consent in your Consent Form. Shown for reference; no new signature.</Note> : null}
          <LegalBox html={content('clearinghouse_single').html} id="chs" />
          <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>{str(content('clearinghouse_single').period) || 'The terms of the consent for single limited query between'}</p>
          <div className="grid">
            <Field path="chs.from" label="From" type="date" req />
            <Field path="chs.to" label="To" type="date" req min={a.chs?.from} err="The end date must be on or after the start date." />
          </div>
          {!chsLinked && f.required.has('clearinghouse_single') ? (
            <>
              <div className="grid" style={{ marginTop: 12 }}>
                <ReadOnly label="Driver:" value={fullName(a) || '—'} />
                <ReadOnly label="DATE:" value={fmtDate(f.today)} />
              </div>
              <Sig k="clearinghouse_single" label="Signature:" />
            </>
          ) : null}
        </DocCard>
      ) : (
        <DocCard title={title('clearinghouse_single')}>
          <PendingLegal names={[title('clearinghouse_single')]} />
        </DocCard>
      )}
      {ok('user_copy') ? (
        <>
          <h2 className="blk">User Requested Copy</h2>
          <Chk path="copy.requested" html={content('user_copy').text} />
          {a.copy?.requested ? (
            <div className="grid" style={{ marginTop: 12 }}>
              <Field path="copy.email" label="Email address" type="email" req err="Enter a valid email address." />
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * The FCRA Disclosure + Authorization again, once per employer and trucking school in Employment
 * history ("Employer / Contractor / Educational Institution:"): each with its own acknowledgement and
 * its own signature. Not covered by the Consent Form.
 */
function FcraEntities() {
  const { f, content, ok, title } = useDocs();
  const a = f.a;
  const entities = dotAppFcraEntities(a);
  if (!entities.length) return null;
  const pair = [
    ['fcra_disclosure_entity', fcraDisclosureKey],
    ['fcra_authorization_entity', fcraAuthorizationKey],
  ] as const;
  if (pair.every(([k]) => !ok(k)))
    return (
      <DocCard title={title('fcra_disclosure_entity')}>
        <PendingLegal names={pair.map(([k]) => title(k))} />
      </DocCard>
    );
  return (
    <>
      {entities.map((x) =>
        pair.map(([docKey, keyOf]) => {
          if (!ok(docKey))
            return (
              <DocCard key={`${docKey}-${x.id}`} title={`${title(docKey)} — ${x.name}`}>
                <PendingLegal names={[title(docKey)]} />
              </DocCard>
            );
          const L = content(docKey);
          const sigKey = keyOf(x.id);
          return (
            <DocCard key={sigKey} title={`${title(docKey)} — ${x.name}`} letterhead={Boolean(L.letterhead)} pill={<Pill k="mute">{x.kind === 'school' ? 'Trucking school' : 'Employer'}</Pill>}>
              <LegalBox html={L.html} id={sigKey} />
              <div className="grid">
                <ReadOnly label={str(L.entityLabel) || 'Employer / Contractor / Educational Institution:'} value={x.name} full />
                <ReadOnly label="Printed Name:" value={fullName(a) || '—'} />
                <ReadOnly label="Social Security #:" value={maskSsn(f.ssn.last4) || '—'} />
                <ReadOnly label="Signed Date:" value={fmtDate(f.today)} />
              </div>
              <div style={{ marginTop: 12 }}>
                <Chk path={`ack.${sigKey}`} html={L.check} req />
              </div>
              {f.required.has(sigKey) ? <Sig k={sigKey} label="Signature" /> : null}
            </DocCard>
          );
        }),
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- 9
export function Policies() {
  const { f, content, ok, title } = useDocs();
  const keys = ['da_receipt', 'ic_ack', 'employee_ack', 'handbook_ack', 'video_consent'];
  if (keys.every((k) => !ok(k))) return <PendingLegal names={keys.map(title)} />;
  const a = f.a;
  const dar = content('da_receipt');
  const items = Array.isArray(dar.items) ? (dar.items as string[]) : [];
  const ic = content('ic_ack');
  const pages = Array.isArray(ic.pages) ? (ic.pages as { label?: string; initials?: boolean; html?: string }[]) : [];
  const vid = content('video_consent');
  const vidItems = Array.isArray(vid.items) ? (vid.items as string[]) : [];
  const pending = (key: string) => (
    <DocCard key={key} title={title(key)}>
      <PendingLegal names={[title(key)]} />
    </DocCard>
  );
  return (
    <>
      {ok('da_receipt') ? (
        <DocCard title={title('da_receipt')}>
          <div className="grid" style={{ marginBottom: 12 }}>
            <ReadOnly label="Employee’s Name" value={[a.personal?.firstName, a.personal?.lastName].filter(Boolean).join(' ')} />
            <ReadOnly label="Company/Department" value={f.company.legalName} />
          </div>
          <Html as="p" html={dar.intro} />
          <div className="chk-list">
            {items.slice(0, 12).map((t, i) => (
              <Chk key={i} path={`dar.i${i + 1}`} html={t} req />
            ))}
          </div>
          {items[12] ? (
            <div style={{ marginTop: 12 }}>
              <Chk path="dar.i13" html={items[12]} />
            </div>
          ) : null}
          <div className="grid" style={{ marginTop: 12 }}>
            <Field path="dar.optional" label={items[12] ? 'Optional Information (optional)' : <Html html={items[12] ?? ''} />} type="textarea" full />
          </div>
          <Sig k="da_receipt" label="Employee’s Signature" />
        </DocCard>
      ) : (
        pending('da_receipt')
      )}

      {ok('ic_ack') ? (
        <DocCard title={title('ic_ack')} letterhead={Boolean(ic.letterhead)} pill={<Pill k="mute">{`${pages.length} pages`}</Pill>}>
          {pages.map((pg, i) => {
            const path = `ica.init${i}`;
            const v = str(getP(a, path));
            const invalid = f.errors.has(path);
            return (
              <details className="rep" key={i} open={i === 0 || invalid}>
                <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                  {pg.label}{' '}
                  {pg.initials ? v ? <Pill k="ok">Initialed</Pill> : <Pill k="warn">Initials required</Pill> : null}
                </summary>
                <Html as="div" className="legal" html={pg.html} />
                {pg.initials ? (
                  <div className={`initials f${invalid ? ' invalid' : ''}`} data-key={path}>
                    <label htmlFor={idOf(path)} style={{ fontSize: 12.5, fontWeight: 600 }}>
                      ___________ Initials
                      <span className="req" aria-hidden="true">
                        *
                      </span>
                    </label>
                    <input className="inp" id={idOf(path)} maxLength={4} value={v} autoComplete="off" aria-required onChange={(e) => f.set(path, e.target.value.toUpperCase())} />
                    <div className="err-msg">Initials required.</div>
                  </div>
                ) : null}
              </details>
            );
          })}
          <div className="grid">
            <Field path="ica.printName" label="Print name" req />
            <ReadOnly label="Date" value={fmtDate(f.today)} />
          </div>
          <Sig k="ic_ack" label="Signature" />
        </DocCard>
      ) : (
        pending('ic_ack')
      )}

      {ok('employee_ack') ? (
        <DocCard title={title('employee_ack')}>
          <LegalBox html={content('employee_ack').html} id="ea" />
          <Sig k="employee_ack" label="Employee signature" />
        </DocCard>
      ) : (
        pending('employee_ack')
      )}
      {ok('handbook_ack') ? (
        <DocCard title={title('handbook_ack')}>
          <LegalBox html={content('handbook_ack').html} id="hb" />
          <div className="grid">
            <Field path="hb.printName" label="Print name" req />
            <ReadOnly label="Date" value={fmtDate(f.today)} />
          </div>
          <Sig k="handbook_ack" label="Signature" />
        </DocCard>
      ) : (
        pending('handbook_ack')
      )}
      {ok('video_consent') ? (
        <DocCard title={title('video_consent')}>
          <LegalBox html={vid.html} id="vid" />
          {vidItems.map((t, i) => {
            const path = `vid.i${i}`;
            const invalid = f.errors.has(path);
            return (
              <div className={`initials f${invalid ? ' invalid' : ''}`} key={i} data-key={path}>
                <input
                  className="inp"
                  maxLength={4}
                  id={idOf(path)}
                  value={str(getP(a, path))}
                  autoComplete="off"
                  aria-required
                  onChange={(e) => f.set(path, e.target.value.toUpperCase())}
                />
                <label htmlFor={idOf(path)} style={{ fontSize: 13 }}>
                  - <Html html={t} />
                  <span className="req" aria-hidden="true">
                    *
                  </span>
                </label>
                <div className="err-msg" style={{ width: '100%' }}>
                  Initials required.
                </div>
              </div>
            );
          })}
          <Html as="p" html={vid.after} />
          <Sig k="video_consent" label="Employee signature" />
        </DocCard>
      ) : (
        pending('video_consent')
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- 10
export function Contractor() {
  const { f, content, ok, title } = useDocs();
  if (!ok('w9') && !ok('occ_accident') && !ok('ach_debit')) return <PendingLegal names={[title('ach_debit'), title('w9'), title('occ_accident')]} />;
  const a = f.a;
  const w9 = content('w9');
  const oa = content('occ_accident');
  const carrier = [f.company.legalName, f.company.address, f.company.phone].filter(Boolean).join(', ');
  return (
    <>
      {ok('ach_debit') ? (
        <AchDebit />
      ) : (
        <DocCard title={title('ach_debit')}>
          <PendingLegal names={[title('ach_debit')]} />
        </DocCard>
      )}
      {ok('w9') ? (
        <DocCard title={title('w9')}>
          {str(w9.head) ? <Html as="div" className="legal-inline" html={w9.head} /> : null}
          <div className="grid">
            <Field path="w9.name" label="1 Name (as shown on your income tax return). Name is required on this line; do not leave this line blank." req full />
            <Field path="w9.business" label="2 Business name/disregarded entity name, if different from above" full />
            <Field
              path="w9.cls"
              label="3 Check appropriate box for federal tax classification of the person whose name is entered on line 1. Check only one of the following seven boxes."
              req
              full
              opts={OPT.w9Class}
            />
            {a.w9?.cls === 'Limited liability company' ? <Field path="w9.llc" label="Enter the tax classification (C=C corporation, S=S corporation, P=Partnership)" req opts={['C', 'S', 'P']} /> : null}
            {a.w9?.cls === 'Other (see instructions)' ? <Field path="w9.other" label="Other (see instructions)" req /> : null}
            {str(w9.line3Note) ? <Html as="p" className="hint full" html={w9.line3Note} /> : null}
            {str(w9.exemptions) ? <Html as="p" className="hint full" html={w9.exemptions} /> : null}
            <Field path="w9.exemptPayee" label="4 Exempt payee code (if any)" />
            <Field path="w9.fatca" label="Exemption from FATCA reporting code (if any)" hint={str(w9.fatcaNote) || undefined} />
            <Field path="w9.address" label={str(w9.line5) || '5 Address (number, street, and apt. or suite no.)'} req full />
            <Field path="w9.csz" label="6 City, state, and ZIP code" req full />
            {str(w9.requester) ? <ReadOnly label={str(w9.requester)} value="Completed by the requester" full /> : null}
            <Field path="w9.accounts" label="7 List account number(s) here (optional)" full />
            {str(w9.part1) ? <Html as="div" className="hint full" html={w9.part1} /> : null}
            <Field path="w9.tinType" label="Part I Taxpayer Identification Number (TIN)" req opts={['Social security number', 'Employer identification number']} />
            {a.w9?.tinType === 'Employer identification number' ? (
              <Field path="w9.ein" label="Employer identification number" req ph="XX-XXXXXXX" im="numeric" />
            ) : (
              <ReadOnly label="Social security number" value={maskSsn(f.ssn.last4)} />
            )}
          </div>
          <Html as="div" className="legal legal-full" html={w9.cert} />
          <Chk path="w9.crossItem2">I have been notified by the IRS that I am currently subject to backup withholding (cross out item 2).</Chk>
          <Sig k="w9" label="Signature of U.S. person" />
          {str(w9.instructions) ? (
            <details className="rep" style={{ marginTop: 12 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>General Instructions · Purpose of Form</summary>
              <Html as="div" className="legal legal-full" html={w9.instructions} />
            </details>
          ) : null}
        </DocCard>
      ) : (
        <DocCard title={title('w9')}>
          <PendingLegal names={[title('w9')]} />
        </DocCard>
      )}
      {ok('occ_accident') ? (
        <DocCard title={title('occ_accident')}>
          {str(oa.notEligible) ? (
            <Note kind="warn">
              <b>
                <Html html={oa.notEligible} />
              </b>
            </Note>
          ) : null}
          <p className="hint">Motor carrier information ({carrier}) and Effective Date of Your Contract are completed by the carrier.</p>
          <h2 className="blk">INDIVIDUAL DRIVER INFORMATION</h2>
          <div className="grid">
            {a.oa?.feinNone ? <ReadOnly label="FEIN Number" value="None" /> : <Field path="oa.fein" label="FEIN Number" req err="Enter the FEIN, or tick None." />}
            <div className="f" style={{ alignSelf: 'end' }}>
              <Chk path="oa.feinNone">None</Chk>
            </div>
            <Field path="oa.years" label="Number of Years Experience" req im="numeric" />
            <YN path="oa.sex" q="Sex (as printed on insurer form)" opts={['Male', 'Female']} />
            <Field path="oa.height" label="Height" req />
            <Field path="oa.weight" label="Weight" req im="numeric" />
            <Field path="oa.homePhone" label="Home Phone" type="tel" im="tel" />
            <Field path="oa.beneficiary" label="Beneficiary" req />
            <Field path="oa.relationship" label="Relationship to Beneficiary" req />
          </div>
          <p className="hint">Name, Address, CDL Number, Date of Birth, Cell Phone and Email are taken from your application.</p>
          <h2 className="blk" style={{ marginTop: 22 }}>
            GENERAL INFORMATION
          </h2>
          <YN path="oa.q1" q="1. Do you own and operate your own truck?" />
          <YN path="oa.q2" q="Do you operate a truck under a lease to purchase plan?" />
          <YN path="oa.q3" q="Do you operate a truck as a 1099 contract driver, but do not own or lease the truck?" />
          {a.oa?.q3 === 'Yes' ? (
            <div className="grid">
              <Field path="oa.q3who" label="If Yes, for whom?" req />
            </div>
          ) : null}
          <YN path="oa.q4" q="4. Do you operate a truck as part of a team or as a co-driver?" />
          {a.oa?.q4 === 'Yes' ? (
            <div className="grid">
              <Field path="oa.q4who" label="If Yes, with whom?" req />
            </div>
          ) : null}
          <Multi path="oa.equip" label="5. Equipment type:" opts={OPT.oaEquip} req />
          {(a.oa?.equip ?? []).includes('Other') ? (
            <div className="grid">
              <Field path="oa.equipOther" label="Other, please specify:" req />
            </div>
          ) : null}
          <YN path="oa.q6" q="6. Have you filed a workers' compensation or occupational accident claim in the past 3 years?" />
          {a.oa?.q6 === 'Yes' ? (
            <div className="grid">
              <Field path="oa.q6ex" label="If Yes, please explain:" type="textarea" req full />
            </div>
          ) : null}
          <YN path="oa.q7" q="7. Are you covered under any other medical and/or disability insurance plan?" />
          {a.oa?.q7 === 'Yes' ? (
            <div className="grid">
              <Field path="oa.q7carrier" label="If Yes, name of insurance carrier:" req />
            </div>
          ) : null}
          <Html as="div" className="legal legal-full" html={`<p>${str(oa.fraud)}</p>${str(oa.ack)}`} />
          <Sig k="occ_accident" label="Driver's Signature" />
        </DocCard>
      ) : (
        <DocCard title={title('occ_accident')}>
          <PendingLegal names={[title('occ_accident')]} />
        </DocCard>
      )}
    </>
  );
}


/**
 * CONSUMER AUTHORIZATION FOR DIRECT PAYMENT VIA ACH (ACH DEBITS), the company's own document. The
 * routing and account numbers never go into the answers: they are sent once, sealed on the server,
 * and shown back only as "•••• 1234 On file".
 */
function AchDebit() {
  const { f, content, title } = useDocs();
  const a = f.a;
  const L = content('ach_debit');
  const lab = (L.fields ?? {}) as Record<string, string | undefined>;
  const ein = a.w9?.tinType === 'Employer identification number' && a.w9?.ein ? a.w9.ein : '';
  return (
    <DocCard title={title('ach_debit')} letterhead={Boolean(L.letterhead)}>
      <Html as="div" className="legal-inline" html={L.intro} />
      <div className="grid">
        <Field path="ach.name" label={lab.name ?? 'Print Name (Company Name):'} req full />
        <Field path="ach.address" label={lab.address ?? 'Address:'} req full />
        <div className="f">
          <ReadOnly label={lab.ssn ?? 'SSN (EIN):'} value={ein || maskSsn(f.ssn.last4) || '—'} />
          <div className="hint">{ein ? 'From your W-9 (EIN).' : 'From Personal information (masked).'}</div>
        </div>
      </div>
      <Html as="div" className="legal-inline" html={L.authorize} />
      <YN path="ach.accountType" q={`${lab.checking ?? 'Checking Account'} / ${lab.saving ?? 'Saving Account (select one)'}`} opts={DOT_APP_ACH_ACCOUNT_TYPES} />
      <Html as="div" className="legal-inline" html={L.depository} />
      <div className="grid">
        <Field path="ach.bank" label={lab.bank ?? 'Depository Bank Name'} req full />
        <BankNumbers routingLabel={lab.routing ?? 'Routing Number'} accountLabel={lab.account ?? 'Account Number'} />
        <Field path="ach.email" label={lab.email ?? 'Email'} type="email" req err="Enter a valid email address." />
      </div>
      <Html as="div" className="legal-inline" html={L.revoke} />
      <div className="grid">
        <ReadOnly label={lab.date ?? 'Date'} value={fmtDate(f.today)} />
      </div>
      <Sig k="ach_debit" label={lab.signature ?? 'Signature'} />
    </DocCard>
  );
}

/** Routing + account numbers: typed once, sealed on the server, then "•••• 1234 On file" with Change. */
function BankNumbers({ routingLabel, accountLabel }: { routingLabel: string; accountLabel: string }) {
  const f = useForm();
  const b = f.bank;
  const invalid = f.errors.has('ach.numbers');
  if (b.onFile && !b.editing)
    return (
      <div className="f full" data-key="ach.numbers">
        <label className="lbl" htmlFor="f_ach_numbers">
          {routingLabel} · {accountLabel}
          <span className="prefill">On file</span>
        </label>
        <div className="inp-row">
          <input className="inp" id="f_ach_numbers" value={`•••• ${b.last4 ?? ''}`} readOnly aria-label="Bank account (masked)" />
          <button type="button" className="btn btn-ghost" onClick={b.startEdit}>
            Change
          </button>
        </div>
        <div className="hint">Stored encrypted. Only authorized Safety staff can view the full numbers.</div>
      </div>
    );
  const routingOk = /^\d{9}$/.test(b.routing);
  return (
    <div className={`full grid${invalid ? ' invalid' : ''}`} data-key="ach.numbers" style={{ margin: 0 }}>
      <div className={`f${invalid && !routingOk ? ' invalid' : ''}`}>
        <label htmlFor="f_ach_routing">
          {routingLabel}
          <span className="req" aria-hidden="true">
            *
          </span>
        </label>
        <input className="inp" id="f_ach_routing" inputMode="numeric" autoComplete="off" maxLength={9} value={b.routing} aria-required onChange={(e) => b.set('routing', e.target.value)} />
        <div className="err-msg">Enter the 9-digit routing number (it is checked).</div>
      </div>
      <div className={`f${invalid ? ' invalid' : ''}`}>
        <label htmlFor="f_ach_account">
          {accountLabel}
          <span className="req" aria-hidden="true">
            *
          </span>
        </label>
        <input className="inp" id="f_ach_account" inputMode="numeric" autoComplete="off" maxLength={17} value={b.account} aria-required onChange={(e) => b.set('account', e.target.value)} />
        <div className="err-msg">Enter a valid routing number and the account number (4–17 digits).</div>
      </div>
    </div>
  );
}
