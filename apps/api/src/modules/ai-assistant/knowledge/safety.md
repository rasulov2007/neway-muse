# Safety & Compliance

The Safety & Compliance menu is where the safety team works accidents, post-accident drug and alcohol testing, roadside inspections, violations (inspections, citations and warnings), insurance claims and driver charges, driver reviews, the driver qualification (DQ) file, and the hiring decisions Recruiting sends to Safety. Every record is kept on the server with a case number (ACC-001 accidents, CLM-001 claims, V-001 violations, INS-001 roadside inspections, REV-001 reviews, DAT-001 drug and alcohol tests), an owner, a next action with a due date, a timeline, and documents. Nothing is deleted: a record entered in error is voided with a reason. All times are US Eastern.

## Safety overview: what needs attention today

Path: Safety & Compliance › Safety (/safety) · Permission: safety.view
Needs to change: safety.manage (for "Record incident")

The Safety overview is the safety team's start page: five counts, the next action of every open case in priority order, and the open accident and claim files. Every number is a count of real records; test records and voided records are never counted.

What you see:
- Five tiles: "Urgent tasks" (high-priority items), "Open accidents", "Active claims", "Unresolved violations", and "Compliance due" (qualification items that expire within the next 30 days or are already expired; clicking it opens Driver Qualifications).
- "Needs attention": one row per open case with Priority, Task, Driver & truck, Owner, Due and an "Open" button that goes to the case. Priority is High when the task is overdue, or for an out-of-service violation or roadside inspection still open, or an unresolved post-accident test; Medium when due within 2 days; otherwise Low. If empty it says "Nothing needs attention."
- "Open accident and claim cases": Case, Type, Current stage, Next action, Owner, Target date.
- "Safety program": links to Compliance, PTI & roadside inspections, Accidents, Claims, Violations, Testing and Driver reviews, plus "Workbench" (the full compliance workbench).

Steps to record an accident from here:
1. Click "Record incident" (only shown with safety.manage).
2. Fill the "Record accident" form and click "Record accident". The new accident file opens.

Dispatch holds are not set by hand: a driver's or unit's "Cannot be dispatched" hold is derived from the qualification file (an expired or missing required item). It lifts by itself when the item is fixed (see the DQ document section).

Why it won't work
- No "Record incident" button: you do not hold safety.manage.
- A tile shows a dash or the page shows an error: the page could not load; reload. A user without safety.view cannot open the page.
- Drug-test tasks read "Resolve the alcohol test (restricted)": you do not hold safety_testing.view, so results are hidden from you.

## Record an accident

Path: Safety & Compliance › Accidents (/safety/accidents) · Permission: safety.view
Needs to change: safety.manage

Use this to open an accident file (ACC-xxx). The form shows live, before you save, whether the accident is DOT recordable and whether post-accident alcohol and drug tests are required.

Steps
1. Open Safety & Compliance › Accidents and click "Record accident" (or "Record incident" on the Safety overview, or go to /safety/accidents/new).
2. Fill "Date and time (Eastern)" (required) and "Location" (required, at least 2 characters, e.g. road, mile marker or address).
3. Optional: "City", "State", "Driver" (picking a driver fills their truck), "Truck", "Trailer", "Load", "What happened", "Fatalities", "Injuries", "Injuries treated away from the scene", "Police report #".
4. Tick "A vehicle was towed away with disabling damage" and/or "Our driver was cited for a moving violation" when true. If cited, fill "Citation time (Eastern)" — it decides whether testing is required (within 8 h for alcohol, 32 h for drugs).
5. Read the preview box: "DOT recordable: Yes/No", "Alcohol test: Required / Not required / Needs the citation time", "Drug test: …".
6. Click "Record accident". The toast says "ACC-xxx recorded" and the accident file opens at stage "Reported" with the next action "Confirm the facts and assign an investigator".

After saving, required post-accident tests are created automatically on the accident's Testing tab. The Accidents list has tabs "All incidents", "Open", "Closed" and "DOT register", filters (status, driver, unit, DOT recordable) and "Export DOT register" (CSV).

Why it won't work
- "Record accident" button greyed: date/time missing or Location shorter than 2 characters, or the citation time cannot be read.
- "The accident time is in the future": the date/time is later than now; correct it.
- "The citation cannot come before the accident": the citation time is earlier than the accident time.
- "Where did it happen?": Location is missing.
- No "Record accident" button: you need safety.manage.

## Work an accident file: stages, Mark complete and closing

Path: Safety & Compliance › Accidents (/safety/accidents/<id>) · Permission: safety.view
Needs to change: safety.manage (administrative close also needs safety_testing.manage)

An accident file moves through six stages: "Reported" → "Evidence" → "Testing assessed" → "Repairs & claim" → "Review" → "Closed". The green "Next action" card on top shows what to do now, its owner and due date.

Steps
1. Open the accident from the Accidents list.
2. Do the next action, then click "Mark complete" on the Next action card. The file moves to the next stage and gets the next default action (e.g. "Collect the police report, photos and driver statement", "Resolve post-accident drug and alcohol testing", "Arrange repairs and open the insurance claim", "Complete the driver review and decide preventability").
3. Use "Edit" on the card (or "More actions" › "Owner and next action") to change owner, next action or due date.
4. Tabs: "Overview" (incident facts, "Fault & preventability"), "Testing", "Damage & costs" (repair estimate, company deductible, "Save costs"; "Create claim"; "Link work order" or "Create repair work order (unit in the shop)", the latter needs maintenance.edit), "Documents" ("Add document"), "Timeline".
5. When the file reaches "Review", a driver review (REV-xxx) opens automatically. Preventability is decided in that review, not on the accident.
6. At "Review" the button reads "Close accident". It closes normally only when nothing is outstanding.
7. "More actions" also has "Edit facts", "Create claim" / "Open claim CLM-xxx" (one accident has one claim), "Close administratively…" and "Void (entered in error)…".

Administrative close: "More actions" › "Close administratively…", give a "Reason" of at least 10 characters. It lists what is "Still outstanding"; those items are carried into a new corrective action, not dropped.

Why it won't work
- "ACC-xxx cannot move past Testing assessed yet: …": a required test is neither collected nor documented (e.g. "Alcohol test is required: collect it or document why it was not given").
- Close blocked with "Preventability has not been decided" or "The driver review is not complete": complete the linked driver review in Safety review.
- "ACC-xxx is closed" / "ACC-xxx is already closed": closed files cannot be edited.
- "An administrative closure takes safety.manage and safety_testing.manage": ask a Safety Manager.
- "An administrative closure needs a reason of at least 10 characters".
- "ACC-xxx was changed by someone else at …. Reload it and make your change again.": reload the page and repeat.
- "Name the truck on the accident first": needed before creating a repair work order.

## Post-accident drug and alcohol testing rules (49 CFR 382.303)

Path: Safety & Compliance › Accidents (/safety/accidents/<id>) › Testing tab · Permission: safety.view
Needs to change: safety_testing.manage (record schedule, collection, result, reasons); exception review needs safety.manage and safety_testing.manage

The system decides from the accident facts whether each test is required, separately for alcohol and drug:
- A fatality: both tests required, citation or not.
- Bodily injury treated away from the scene, or a vehicle towed for disabling damage: required only if our driver was cited for a moving violation within 8 hours (alcohol) or 32 hours (drug) of the accident. A citation with no time recorded reads "Cannot tell yet" / "Needs assessment" until the time is entered.
- Otherwise not required.
- Alcohol should be given within 2 hours; after that a reason must be documented. Attempts stop at 8 hours (alcohol) and 32 hours (drug).

Steps (each test card shows "Required", "Rule", "Testing window ends", and for alcohol "Give within 2 hours by")
1. Enter "Scheduled for (Eastern)" and click "Save schedule".
2. Enter "Collected at (Eastern)" and click "Record collection".
3. Choose the result in "Record the result" (Negative, Positive, Refused, Cancelled).
4. If alcohol was given after 2 hours, fill "Why alcohol was given after 2 hours".
5. If the test was not given, refused or could not be completed, fill "Not given / refused / could not complete — why" (at least 5 characters), then a Safety reviewer fills "Safety review of the exception" and confirms.

Results are restricted: without safety_testing.view you see "Result restricted" / "Resolved (restricted)". Receipt of test materials is not a clearance to return to duty.

Why it won't work
- "Recording a collection, a result or a reason takes safety_testing.manage".
- "A post-accident alcohol test may not be collected after … (8 hours). Stop attempting and document why it was not given." (32 hours for drug).
- "The collection time is in the future".
- "Record when the specimen was collected before its result".
- "Document why the test was not completed before reviewing it".
- "Only a test that was missed, refused or could not be completed is reviewed as an exception".
- "Reviewing a testing exception takes safety.manage and safety_testing.manage".
- "A required post-accident test cannot be voided while unresolved; document why it was not completed instead".
- "Post-accident tests are opened from the accident, which decides whether they are required": you cannot create one from the Testing tab of Driver Qualifications.

## Driver Qualifications page (DQ overview)

Path: Safety & Compliance › Driver Qualifications (/safety/compliance) · Permission: compliance.view

The Driver Qualifications page shows, per driver, vehicle and the company, whether each requirement is current. Chips read "Current", "Due soon", "Expired", "Missing", "Pending review", "Rejected", "Waived" or "Not applicable".

Tabs
- "Drivers": tiles "Expired", "Due soon", "Missing"; table "Driver compliance" with columns CDL, Medical qualification, Annual MVR review, Clearinghouse query, Testing program, and Action ("View" opens the driver's file in the workbench, "Upload" attaches a document). A second table "In hiring" lists candidates with a reserved driver id and an open hiring case.
- "Vehicles": "Vehicle compliance" for "Trucks" or "Trailers".
- "Company": "Company compliance checklist" — green only when the document is on file and verified. With documents.create you can set an expiry date and click "Upload" per requirement; it then reads pending verification.
- "Testing": "Testing & Clearinghouse" summary and the "Drug & alcohol tests" list.

The link "Open the compliance workbench" opens the full workbench with tabs "Drivers", "Units", "Trailers", "Documents", "Consent" and "Verification".

Why it won't work
- "Upload" fails with a permission message: uploading needs documents.create.
- "This driver has no qualification file yet.": the driver has no qualification record; open the workbench for the driver.
- A chip says "Pending review": a document was attached but nobody has verified it yet (needs compliance.manage).
- The page or a tab will not load: Drivers and Company need both safety.view and compliance.view on the server.

## Upload, verify, reject or waive a driver qualification document

Path: Safety & Compliance › Driver Qualifications (/safety/compliance) › "View" or "Upload" on a driver · Permission: compliance.view
Needs to change: documents.create (attach), compliance.manage (Verify, Reject, Waive)

Each driver's qualification file lists requirements grouped as missing, pending verification, expiring and expired, plus "In order". If something blocks dispatch, a red box "Cannot be dispatched" lists the reasons. The hold is derived, never set or released by hand.

Steps to attach a document
1. On the Drivers tab click "Upload" on the driver's row and pick the requirement ("Pick a requirement…"), or click "View" and then "Attach…" next to the requirement.
2. In "Attach <requirement>": "Choose file…" (PDF, PNG, JPG, TIF, DOC), "Title" (required), "Issued on" (optional), "Expires on" (required when the requirement expires), "Notes".
3. Click "Attach document". The item moves to pending verification. If it was blocking dispatch, attaching lifts that hold while a reviewer checks the file.

Steps to review
1. Open the driver ("View"), find the item or document marked pending.
2. Click "Verify" to accept, or "Reject", type why ("Why this document cannot be accepted") and click "Reject document". A rejected item reads verification failed until a new document is verified.
3. To accept a known gap for a while, click "Waive…", set "Waived until" and "Reason", then "Record waiver". The requirement re-evaluates the day the waiver ends.

Why it won't work
- "Attach document" greyed: no file chosen or Title empty.
- "<requirement> expires, so an expiry date is required": fill "Expires on".
- "No requirement with code …": the requirement no longer exists; reload.
- "… cannot be marked not applicable; it must be evidenced": that requirement needs a document.
- "Record waiver" greyed: pick a date and write a reason.
- No Verify/Reject/Waive buttons: you need compliance.manage.
- "… is recorded but its file is not held by this system": the record exists but there is no stored file to view.

## Record a drug or alcohol test (random, pre-employment, return-to-duty)

Path: Safety & Compliance › Driver Qualifications (/safety/compliance) › Testing tab · Permission: compliance.view (the list itself reads with safety.view)
Needs to change: safety.manage and safety_testing.manage

Use this for tests that do not come from an accident: Pre-employment, Random, Reasonable suspicion, Return-to-duty, Follow-up, Vacation return (company policy). Post-accident tests are created by the accident and are not offered here.

Steps
1. Open the Testing tab and click "Record a test" (shown only with safety_testing.manage).
2. In "Record a drug or alcohol test" choose "Type", "Substance" (Drug or Alcohol), "Driver" (required) and optionally "Scheduled for (Eastern)".
3. Click "Open test". The test (DAT-xxx) appears in "Drug & alcohol tests" with its status: "Required — not scheduled", "Scheduled", "Collected", "Result pending", "Result recorded", "Not completed — needs review" or "Exception reviewed".

Results are restricted to people with safety_testing.view; others see "Resolved (restricted)".

Why it won't work
- No "Record a test" button: you need safety_testing.manage.
- "Open test" greyed: choose the driver.
- "Post-accident tests are opened from the accident, which decides whether they are required".
- "Recording a collection, a result or a reason takes safety_testing.manage".

## Roadside inspections (truck and trailer)

Path: Safety & Compliance › Inspections (/safety/inspections) · Permission: safety.view, trucks.view or trailers.view (any one)
Needs to change: safety.manage (repair work orders also need maintenance.edit)

Roadside (DOT) inspections of a truck, trailer and driver. Each inspection (INS-xxx) has a checklist: "Received" → "Reviewed" → "Defects corrected" → "Certified" → "Returned if requested" (the last only when the agency asked for the signed report back). Status is "Clean" (no violations, not out of service), "Open" or "Closed".

Steps to add one
1. Click "Add inspection".
2. Fill "Date and time (Eastern)" (required), "Level", "Agency" (required, at least 2 characters), optional "Report number", "Location", "State", "Driver", "Truck", "Trailer", "Correction due".
3. Tick "Vehicle placed out of service" and/or "Agency asked for the signed report back" when true.
4. Click "Add inspection". The inspection opens in a side panel.
5. Click "Add violation" for each violation on the report ("Violation", "Rule / source code", "Category", "Issued to" Carrier/Driver, "Fine ($)", "Correction deadline", "Out-of-service violation"). Each becomes its own violation linked to the inspection.
6. Use "Mark reviewed", "Mark defects corrected", "Mark certified" to move through the checklist.
7. For repairs: choose a work order and "Link work order", or "Create repair work order (unit in the shop)".
8. Attach the inspection report, repair evidence, carrier certification or return report under Documents.

An out-of-service inspection still open shows "Vehicle out of service — repairs required".

Why it won't work
- "Add inspection" greyed: Agency shorter than 2 characters or date missing.
- "The inspection time is in the future".
- "Which agency inspected?": Agency missing.
- "Certify the inspection once every violation is corrected": finish each violation's correction first.
- "INS-xxx is at <stage>; the next step is <stage>": steps go in order.
- "INS-xxx has nothing more owed": the last required step is done.
- "Name the truck on the inspection first": needed for "Create repair work order".
- "INS-xxx is void and cannot be changed".

## Hiring decisions: mark a candidate Qualified or Not qualified

Path: Safety & Compliance › Hiring decisions (/safety/hiring) · Permission: compliance.manage

Candidates Recruiting sent to Safety, with the signed consents and the reports Recruiting filed (MVR, PSP, Clearinghouse). Safety decides "Qualified" or "Not qualified", or checks with insurance first. The list has "Waiting for decision" and "Decided"; each row reads "Waiting", "Checking with insurance", "Qualified" or "Not qualified".

Steps
1. Open Hiring decisions and pick a candidate. Read "Signed consents" and "Reports". "Open candidate" goes to the recruiting card.
2. To qualify: click "Qualified". The toast says "Qualified — Recruiting can now send the application."
3. To decline: click "Not qualified", write "Why" (at least 3 characters) and confirm "Not qualified". The candidate is closed and Recruiting is told; everything is kept and audited.
4. To ask the insurer first, use "Insurance check" (see the insurance section).

The hint under the buttons explains the state, e.g. "Qualified opens the application for Recruiting. The Clearinghouse queries are optional."

Why it won't work
- "Qualified" greyed with "Qualified needs a reviewed MVR and PSP report.": Recruiting must file both reports with a result.
- "A Clearinghouse result shows a prohibition: this candidate cannot be qualified."
- "Waiting for the insurance answer: record it before Qualified." / server: "Waiting for the insurance answer: record it first."
- "The insurer declined this driver."
- "Approval needs: …": lists missing reports, e.g. "…: not on file" or "…: no result recorded".
- "The review is already decided." / "Someone else changed this review. Reload and try again."
- "This candidate has not been sent to Safety yet."
- "Say why.": a Not qualified decision needs a reason.
- "Only Safety (compliance manage) can do this.": you lack compliance.manage; the menu item is hidden without it.

## Insurance check for a driver candidate

Path: Safety & Compliance › Hiring decisions (/safety/hiring) › candidate › "Insurance check" · Permission: compliance.manage

Before qualifying a candidate, Safety can ask the insurer whether they accept the driver. While the check is pending, the candidate cannot be marked Qualified.

Steps
1. Open the candidate and click "Insurance check".
2. Optional "Note (optional)", then "Send to insurance". Recruiting is told ("Checking with insurance"). The candidate row shows "Checking with insurance".
3. When the insurer answers, click "Insurance response" (or "I already have the answer" in the first dialog).
4. Choose "Insurance answer": "Approved — the insurer accepts the driver" or "Declined — the insurer does not accept the driver". A decline needs "What the insurer said" (at least 3 characters).
5. Click "Save the answer". The status shows "Insurance approved" or "Insurance declined" with who answered and when.

After "Insurance approved" you can click "Qualified" (if MVR and PSP are reviewed). After "Insurance declined", Qualified stays blocked; mark the candidate "Not qualified".

Why it won't work
- "Say what the insurer answered.": a declined answer needs the insurer's words.
- "The review is already decided.": the candidate was already Qualified or Not qualified.
- "Someone else changed this review. Reload and try again."
- "This candidate has not been sent to Safety yet."

## Safety review: driver reviews, coaching and corrective actions

Path: Safety & Compliance › Safety review (/safety/review) · Permission: safety.view
Needs to change: safety.manage

Follow-up with drivers. Tabs "Driver reviews", "Coaching", "Corrective actions"; tiles "Reviews due", "Coaching open", "Overdue actions". Reviews open themselves from an accident reaching Review ("Accident review", preventability required), from a violation that names a driver ("Violation review"), and from an administrative accident closure (corrective action). You can also open one by hand.

Steps
1. To open one: click "New driver review" / "New coaching" / "New corrective action", choose "Driver", fill "Reason" (required), optional "Required training" and "Due", click "Open".
2. Click "View" on a row to open it. Tabs "Summary" (related accidents, claims, violations; review details), "Action plan", "History".
3. In "Action plan" set "Status" (Not started, Scheduled, In progress), "Scheduled for", "Preventability" (accident reviews only: Under review, Preventable, Not preventable), "Required training", "Training completed on", "Notes", "Outcome" (required to complete), "Follow-up date", "Evidence". Click "Save action plan".
4. Click "Complete review". For an accident review, the preventability decided here is written back to the accident.

Why it won't work
- "Complete review" greyed with reasons listed: "Decide preventability", "Complete the required training: <training>", "Write down the outcome".
- "The review cannot be completed yet: …" (same reasons, from the server).
- "REV-xxx is complete; open a follow-up review instead" / "REV-xxx is already complete".
- "Open" greyed in the new-review dialog: Reason shorter than 2 characters.
- "The linked case is not in this company".

## Claims page: queues and numbers

Path: Safety & Compliance › Claims (/safety/claims) · Permission: safety.view
Needs to change: safety.manage (New claim)

The Claims page tracks insurance claims and the money owed to and by the company. Number cards (click to filter): "Open claims", "Total gross exposure", "Projected company net cost", "Awaiting insurance", "Driver notification pending", "Pending Accounting approval", "Outstanding recoveries", "Disputed", "No update ≥ 7 days", "Recovered YTD". Test claims are listed but never counted.

Queues (tabs)
- "Needs attention": ranked by risk, e.g. "Driver not informed of $X charge", "Driver disputes $X charge", "Accounting approval needed · $X", "Overdue: <next action>", "Reserve not set", "No update in N days". Side cards "Open exposure by claim type" and "Open claim age".
- "All open": every open claim with Type, Incident, Driver · unit · load, Status, Driver charge, Exposure, Outstanding, Next action. Search "Search claim, driver, unit, load, insurer #", type and status filters.
- "Driver charges": sections "Notification pending (on hold)", "Waiting on Management", "With Accounting", "Being recovered", "Finished".
- "Recoveries": "Owed to us" from insurers and drivers.
- "Disputed", "My actions" (claims you own), "Closed".

Claim statuses shown: "Under investigation", "Liability decided", "Awaiting insurance", "Insurer decision", "Settlement pending", "Disputed", "Closed", "Void".

Reminders run every morning at 06:00 Eastern: a charge on hold goes to Safety managers after 3 business days and Management after 7; a charge waiting for Accounting goes to Accounting after 3 business days; a claim with no activity for 7 days goes to Safety.

Why it won't work
- No "New claim" button: you need safety.manage.
- The page will not open: you need safety.view (the default Accounting role does not have it).

## Open a new claim

Path: Safety & Compliance › Claims (/safety/claims) › "New claim" · Permission: safety.view
Needs to change: safety.manage

One incident is one claim file with one or more lines. Start from an accident, a load, or nothing.

Steps
1. Click "New claim".
2. "Start from": pick an open accident ("Accident ACC-xxx … (no claim yet)" or "(claim CLM-xxx · adds lines)"), "A load · cargo exception" (then pick the "Load"), or "Nothing linked (manual)" (optional "Driver", "Truck"). Driver, unit, trailer and load carry over from the accident.
3. "What kind of claim? (pick all that apply · each becomes a line)": "Damage to our truck / trailer", "Damage we caused to others (liability)", "Cargo damage / shortage / loss", "Recovery from the other party", "Injury (workers' comp, restricted)".
4. "Initial reserve ($)": leave empty for unknown exposure.
5. "Insurer": a known insurer, "Other…" (type the "Insurer name") or "Not filing (company pays)".
6. "What happened" (from an accident, left empty it is carried from the accident). Tick "Test data (kept, never counted in a total)" only for test records.
7. Click "Open claim" (or "Add lines" when the accident already has a claim). The claim file opens at "Opened" with next action "Gather the documents and submit the claim to the insurer".

You can also click "Create claim" on an accident (More actions or Damage & costs tab); that opens a physical-damage claim linked to the accident.

Why it won't work
- "Open claim" greyed: nothing chosen in "Start from", no kind ticked ("Pick at least one."), or a cargo line without a load ("A cargo claim names the load (or starts from the accident).").
- "A cargo claim names the load (or the accident)": server version of the same rule.
- "ACC-xxx is void": the accident was voided.
- "That accident is not in this company".
- Toast "Lines added to CLM-xxx, already open for that accident": the accident already had a claim; the new lines were added to it instead of a second claim.

## Work a claim file: liability, updates, insurer decision, payments, closing

Path: Safety & Compliance › Claims (/safety/claims/<id>) · Permission: safety.view
Needs to change: safety.manage (Confirm/Reject on "Suggested for accounting" needs accounting.edit)

The claim file shows the status, a six-step bar ("Reported", "Investigation", "Liability decided", "Insurance / recovery", "Settled", "Financially closed"), "What happened", "Who is responsible", "Financial exposure", and the next action.

Steps
1. "Liability": choose who is responsible — "Our driver", "Other party", "Shared" (enter "Our share (%)"), "No one", "Under review" — with an optional "Note", then "Save". A driver deductible can only be applied when liability is Our driver or Shared.
2. "Add update" / "Log update / set next": write "What happened" (at least 3 characters), optionally a new "Next action", "Due" and "Owner", then "Save update". This also resets the "No update in N days" clock.
3. "More" › "Edit details and amounts": insurer, policy number, insurer reference, claimed amount, adjuster name/phone/email, "Proposed driver deduction ($)" (a proposal only), description.
4. Insurer decision (in "Claim lines" when the claim is at insurer review or decision): "Insurer decision", "Decision date", "Approved amount ($)", "Company deductible ($)", then "Save decision".
5. "Money" tab: "Claim ledger", "Payments" — "Received on", "Amount ($)", "Reference", "Record payment" — and "Suggested for accounting" (insurer approval, deductible and each payment appear for Accounting to "Confirm" or "Reject"; nothing is posted automatically).
6. "Documents" tab shows the required checklist for the claim type (e.g. Police report, Photos, Repair estimate, Final repair invoice, Insurer acknowledgment); missing items are listed.
7. "More" › "Close claim…": give the reason (settled, withdrawn…). "Void (entered in error)…" voids it; any driver charge is cancelled.

Why it won't work
- "CLM-xxx is closed": closed claims cannot be edited.
- "The insurer denied this claim; there is no payment to record".
- "A payment is more than $0" / "Record payment" greyed: enter an amount.
- "That payment is already void".
- "Say why the entry is rejected": rejecting a suggestion needs a reason.
- "A driver charge is approved or rejected on its charge card, with the checklist".
- "Confirming or rejecting an entry takes accounting.edit".
- "CLM-xxx was changed by someone else at …. Reload it and make your change again."

## Apply a driver deductible on a claim and send it to Accounting

Path: Safety & Compliance › Claims (/safety/claims/<id>) › Overview › Driver charge card · Permission: safety.view
Needs to change: claims.apply_charges or claims.approve_exceptions (apply); safety.manage (Mark driver informed, Send to Accounting); accounting.edit or claims.approve_exceptions (Approve, Reject, Record payment)

A driver charge (deductible or chargeback) is frozen until the driver is told, then Accounting approves it and the settlement engine recovers it. Nothing is deducted until Accounting approves. Policy amount: $5,000 for a company driver, $2,500 for an owner-operator. Per-settlement cap: $250 company driver, $500 owner-operator.

Steps
1. Set liability to "Our driver" or "Shared" and make sure the claim names the driver.
2. On the "Driver charge" card click "Apply driver deductible". Fill "Amount ($)", "Basis" (Accident deductible, Cargo deductible, Damage below the deductible, Lease chargeback, Other) and "Reason" (required when the amount is not the policy amount). If the driver was already told, tick "The driver has already been informed" and fill the notice fields. Click "Apply charge". State: "On hold · driver notification pending".
3. Click "Mark driver informed": "Date informed", "Method" (In person (terminal), Phone call, Driver app, Email, Text message), "Driver response" (Signed acknowledgment, Verbal acknowledgment, Refused to sign, Disputes the charge), "Evidence" (required: signed notice, call log or screenshot). Click "Save notification". State "Driver informed" (or "Disputed" if the driver disputes).
4. Click "Send to Accounting" (optional note). State "Pending Accounting review".
5. Accounting clicks "Approve": "Signed per-charge authorization" (company driver) or "Lease chargeback clause" (owner-operator), "Recovery method", "Per settlement ($)", "Override note (above the cap)" if over the cap, and both checklist boxes. State "Approved", then "Recovering" and "Recovered". Or "Reject" with "Reason" and "Note".
6. "Record payment" records a direct or escrow payment.

Why it won't work
- "Apply driver deductible" greyed: "Record liability as our driver first." or "Name the driver on the claim first."
- "A driver deductible needs liability decided as our driver (or shared). Record who is responsible first."
- "The policy amount is $X; say why this charge is $Y."
- "<driver> already has an active <basis> on CLM-xxx": one active charge per claim, driver and basis.
- "Save notification" greyed / "Attach the evidence: signed notice, call log or screenshot".
- "DCH-YYYY-NNNN can go to Accounting once the driver is informed".
- "DCH-YYYY-NNNN cannot be approved yet: …" e.g. "The driver notice with evidence is not recorded", "Attach the driver’s signed authorization for this charge", "Name the lease chargeback clause that covers this charge", "The installment is above the $X cap; add an override note", "The installment cannot exceed the charge".
- "DCH-YYYY-NNNN is not waiting for Accounting".
- "Applying a driver charge takes claims.apply_charges or claims.approve_exceptions" (similar "… takes …" messages for other actions).

## Driver charge statuses, disputes, holds and waivers

Path: Safety & Compliance › Claims (/safety/claims) › "Driver charges" tab, or a claim's Driver charge card · Permission: safety.view
Needs to change: safety.manage, accounting.edit or claims.approve_exceptions (see each action)

Driver charge statuses: "On hold · driver notification pending", "Driver informed", "Pending Accounting review", "Approved", "Recovering", "Recovered", "Rejected", "Disputed", "Paused", "Waiting on Management", "Waived", "Cancelled". The card shows six steps: On hold, Informed, Accounting review, Approved, Recovering, Recovered.

Actions on the card
- "Put on hold" (reason required): settlements skip the charge until "Resume". Allowed from Driver informed, Pending Accounting review, Approved, Recovering.
- "Record dispute": "Raised by" and "What is disputed" (at least 3 characters). Unposted deductions freeze while Management reviews. Status "Disputed".
- "Resolve dispute" (claims.approve_exceptions only): "Decision" uphold, reduce (with "New amount ($)") or waive, plus a "Note".
- "Waive / adjust": "Change" (waive or adjust with "New amount ($)") and "Reason". Management applies it at once ("Apply"); others send a request ("Request") and the charge shows "Waiting on Management" until Management clicks "Approve waiver" / "Approve amount" or "Decline". An adjustment that stays at or below the policy amount and lowers the charge by no more than $1,000 is applied without Management.
- A charge applied above the policy amount, or more than $1,000 below it, by someone without claims.approve_exceptions goes to "Waiting on Management" first.
- "Apply a new charge" appears after a charge is finished (Recovered, Waived, Rejected).

Why it won't work
- "DCH-YYYY-NNNN is <status>, not on hold": "Mark driver informed" only works on an on-hold charge.
- "DCH-YYYY-NNNN cannot be paused from <status>" / "DCH-YYYY-NNNN is not paused".
- "DCH-YYYY-NNNN cannot be disputed from <status>" / "DCH-YYYY-NNNN is not disputed".
- "A reduced amount is more than zero and less than the charge."
- "DCH-YYYY-NNNN is not open to a change" / "Give the new amount."
- "DCH-YYYY-NNNN is not waiting on Management".
- "DCH-YYYY-NNNN is not being recovered": payments only on Approved or Recovering charges.
- "Say why" / "Explain the decision" / "What does the driver dispute?": the reason field is required.

## Violations page: Inspections, Citations and Warnings

Path: Safety & Compliance › Violations (/safety/violations) · Permission: safety.view
Needs to change: safety.manage

One table of violations, split into three papers: "Inspections", "Citations" and "Warnings" (warnings are their own list). Sub-tabs "All violations", "Needs action", "Closed". Search "Search drivers, violations, notes…", filters "Status" and "Date" (All dates, Last 30 days, Last 90 days, This year). Columns: Date, Driver / Unit, Violation, Charge / Bonus, Status, Training.

Status labels (exact):
- "Needs decision" — nothing decided yet.
- "Charge dismissed" — Safety decided not to charge the driver.
- "Charge · waiting Accounting" — a charge was sent to Accounting and waits for approval.
- "Charged" — Accounting approved the charge (or Safety set it).
- "Bonus · waiting Accounting", "Bonus received", "Bonus dismissed".
- "Ready to close" — charge dismissed, training done or not required, and correction, citation and DataQs all finished.
- "Closed".

"Needs action" lists open violations still at Needs decision or waiting Accounting (charge or bonus), or with training Pending / In progress.

Each row is one paper (one case). One inspection report with three violations is one row, and its "Violation" cell reads like "3 violations: 392.9A2-C (OOS), 393.47E, …". The footer says "Showing N cases".

Click a row (or its "Open" chevron) to expand it: the list "N violations on this paper" with "One driver review: REV-…", one line per violation (code, description, category, "Vehicle OOS" or "No OOS", correction badge and a button with the violation number V-xxx); for citations "Citation number", "State", "Court date", "Dispute", "Court result"; "Documents" ("Upload document"); "Lawyer"; and "Follow-up" (State, Inspection level, Report number, Issued to, OOS, Driver review, Owner) with "Edit record" and "Delete case" ("Delete" when the paper has one violation).

Click a violation's number (V-xxx) to open the "Violation" side panel for that one violation: its facts, tracks "1 · Correction", "2 · Citation and court", "3 · DataQs", and the buttons "Save", "Close violation" and "Delete violation".

Why it won't work
- "Close violation" greyed with "Open: Correction, Citation, DataQs": finish those tracks (correction certified or not required, citation not pending/contested, DataQs not filed/under review).
- "V-xxx has open tracks: Correction is not finished; …".
- "V-xxx is closed" / "V-xxx is void and cannot be changed".

## Add an inspection violation, citation or warning

Path: Safety & Compliance › Violations (/safety/violations) › "Add inspection" / "Add citation" / "Add warning" · Permission: safety.view
Needs to change: safety.manage

One paper is one case (since 2026-10-21): an inspection report, citation or warning with several violations is entered once, as one case. Every violation on it becomes its own record (V-xxx), but they share the date, type, "Issued to", state, report number, driver, truck, fine, documents and one driver review. The form says: "Dates are US Eastern. One paper is one case: every violation on it shares one driver review."

Steps
1. Choose the tab, click "Add inspection", "Add citation" or "Add warning" (the button follows the tab).
2. Fill "Date (Eastern)" (required; today by default). "Violation type" (Inspection, Citation, Warning) is set by the tab.
3. Optional "From roadside inspection" to link it to an INS record ("None (recorded manually)" otherwise). Linking fills the driver, truck, report number, state and level from the inspection when you left them empty.
4. For each violation on the paper, the "Rule / code" comes first (free text, e.g. 393.47E), then "Violation" (required, at least 2 characters; "Violation 1", "Violation 2"… when there are several), then "Category" (Unsafe driving, Hours of service, Driver fitness, Controlled substances, Vehicle maintenance, Hazmat, Crash indicator) and the "OOS" tick box: tick it when that violation put the vehicle out of service. OOS is per violation.
5. Click "Add another violation" for the next line on the same paper. The bin icon ("Remove violation N") removes a line.
6. "Issued to (who received it)": tick Driver, Carrier, or both (shown as "Driver and Carrier"); required for inspections and citations; optional for warnings ("Not recorded").
7. "State": pick it from the list (type a code or a name, e.g. "TN — Tennessee").
8. Optional "Driver", "Truck", "Report number", "Fine ($)" (or tick "N/A").
9. "Add document" (PDF, JPG or PNG, several allowed): "The citation, inspection report or warning — filed once, on the case."
10. Click "Add violation" (or "Add N violations"). The toast says "V-xxx recorded" or "N violations recorded as one case", and the new case opens.

A case that names a driver opens one driver review in Safety review for the whole paper. An OOS violation starts with the correction badge "Repair proof needed" (next action "Repair the out-of-service defect and get proof"); a violation without OOS starts as "No correction needed".

Why it won't work
- "Add violation" greyed: no violation with at least 2 characters, no valid date, or "Issued to" empty on an inspection or citation.
- No "Add inspection" button: you lack safety.manage.
- "What was the violation?": description missing.
- "Add at least one violation".
- "Who received it?" / "Say who received it - only a warning may leave it blank".
- "INS-xxx is void": the linked inspection was voided.

## Delete a violation case or one violation (void with a reason)

Path: Safety & Compliance › Violations (/safety/violations) › row › "Delete case", or V-xxx › "Delete violation" · Permission: safety.view
Needs to change: safety.manage

Deleting a violation is a void: it leaves every list, count and search, but it is kept on record, marked deleted with your name, the time and the reason, and audited. Nothing is erased.

Steps: delete the whole case (the paper)
1. Open Safety & Compliance › Violations and click the case row to expand it.
2. Under "Follow-up" click "Delete case" (it reads "Delete" when the paper has one violation).
3. The dialog "Delete this case? (N violations)" says the report "leaves every list and count, with all its violations and its driver review".
4. Type the "Reason" (at least 3 characters, e.g. "Entered twice by mistake") and click "Delete".
5. Toast: "Case deleted (N violations)" (or "V-xxx deleted").

Steps: delete one violation from a case
1. Expand the case and click the violation's number (V-xxx). The "Violation" side panel opens.
2. Click "Delete violation". The dialog is "Delete this violation?".
3. Type the "Reason" and click "Delete". Toast: "Violation deleted". The other violations on the paper stay.

When the last live violation of a case is deleted, the case disappears; a driver review left with no live violation is voided with the same reason.

Why it won't work
- No "Delete case" / "Delete violation" button: you lack safety.manage, or the violation is already deleted.
- "Delete" greyed: the reason is shorter than 3 characters ("Say why it is being deleted (at least 3 characters)").
- "Cannot delete V-xxx: …" (or "Cannot delete these N violations: …") followed by the reasons:
  - "V-xxx has a charge sent to Accounting - ask Accounting to void it first" (or a bonus).
  - "V-xxx has a DataQs filing (<status>)".
  - "driver review REV-… <why> - finish or void it in Safety review first": the review already has work on it (status beyond not started, scheduled, notes, an outcome, training, a follow-up, documents, or is completed).
- "V-xxx is void and cannot be changed": it was already deleted.
- "… was changed by someone else at <time>. Reload it and make your change again.": reload the page and try again.

## Violation follow-up: training, status, charge or bonus, notes

Path: Safety & Compliance › Violations (/safety/violations) › row › "Edit record" · Permission: safety.view
Needs to change: safety.manage

"Edit record · <driver>" has sections, each saved on its own: "Training", "Status", "Charge / Bonus", "Notes", and for citations "Citation & lawyer".

Steps
1. "Training": "Training status" (Not required, Pending, In progress, Completed), "Completed on", "Trainer", "Proof (optional, one or more files)". Click "Save training".
2. "Status": choose from "Bonus received", "Bonus · waiting Accounting", "Charge · waiting Accounting", "Charged", "Charge dismissed", "Bonus dismissed". Click "Save status". "Waiting Accounting" moves on by itself once Accounting approves.
3. "Charge / Bonus": pick charge or bonus, "Amount", "Charged to" / "Recipient" (the driver), "Reason" (e.g. Tire air leak / Safe driving), then "Send to Accounting". It creates a pending driver-account transaction for Accounting; the violation shows "Charge · waiting Accounting" or "Bonus · waiting Accounting", then "Charged" / "Bonus received" when Accounting approves. Nothing is deducted until Accounting approves.
4. "Notes": type in "Add note" and click "Save note"; notes list under "Saved notes".
5. "Citation & lawyer" (citations): Citation number, State, Inspection level, Court date, Court result, "Disputed", Lawyer name, Phone, Service fee, "Fee paid", then "Save".

Why it won't work
- "Send to Accounting" greyed: amount 0, reason shorter than 2 characters, or no driver on the violation.
- "V-xxx has no driver: Choose the driver on the violation first".
- "V-xxx already has a charge with Accounting: Ask Accounting to void it before sending another".
- Setting "Charge dismissed" refused with "V-xxx has a charge with Accounting: Ask Accounting to void it first".
- "Enter an amount above $0" / "Say why" / "Write the note".
- "V-xxx is closed": closed violations cannot be edited.
