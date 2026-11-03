# HR, Recruiting, Driver Relations and Quality

HR in NeWay TMS is the hiring of drivers: every lead and candidate lives on one Recruiting page (HR › Recruiting), and each candidate walks a nine-step journey (Lead received, Send consent, Consent received, Safety review, Send application, Application received, Onboarding & costs, Ready to hire, Driver profile). Safety decides on candidates on Safety › Hiring decisions. Driver Support › Driver Relations holds every request drivers send from the public Driver Care page. The Quality menu holds the office's own Attendance, PTO and Performance pages.

## Recruiting page: board, dashboard and the More menu

Path: HR › Recruiting (/hr/recruiting) · Permission: recruiting.view
Needs to change: recruiting.manage

What it is for: one page for every driver lead and candidate. The old address /hr/hiring opens this page; /hr/recruiting/analytics opens Recruiting › Analytics.

What you see:
1. Two tabs: "Board" (the front page) and "Dashboard".
2. "Add lead" button (only with recruiting.manage).
3. "More" menu: "Calendar", "Analytics", "Campaigns", "Openings", "Recruiting settings", and "Pipeline board".

The Board:
- Nine columns, left to right: "New Lead" (Not contacted yet), "Lead Screening" (First contact & prequalification), "Consent sent" (Waiting for the signed consent), "Consent received" (Signed · send to Safety), "Safety Review" (Documents & verification), "Application" (Send · Awaiting · Received), "Onboarding & Costs" (Final review & setup), "Ready to Hire" (Hire → Driver profile), "Disqualified" (Not eligible · kept on record). Hired and closed people are not on the board.
- Summary cards: "Active candidates", "Awaiting consent", "Safety review", "Ready to hire".
- Search box "Search name, phone or email…".
- With recruiting.manage you can switch "All leads" / "My leads" and pick a recruiter ("All recruiters", "Unassigned" or a name). Without it you only see your own leads.
- Each card shows name, phone, "Recruiter:" (or "Unassigned"), driver type (CD, LO, OO), the status badge, the next step, recorded cost (in onboarding columns) and how long ago the candidate reached the current step (e.g. "3 days ago"; only shown when a stored time exists).
- Cards do not move by dragging. Click a card (or "Open candidate" in its ⋮ menu) to work it. On "Ready to Hire" cards a "Hire driver" button opens the hire step.

The Dashboard: pick a period ("This month", "Last 7 days", "Last 30 days", "Last month", "This year", "Custom range") and a recruiter. Shows "Total leads", "Hired", "Lead → hire", "In progress", "Where leads come from", "Recruiting stages", "Lead trend", "Next actions", "Recent leads". Every number counts the leads received in the period.

Why it won't work
- "The board could not load" – network or server error; press "Try again".
- "All leads needs the recruiting manage permission." – you asked for everyone's leads without recruiting.manage.
- "This candidate is assigned to another recruiter" – without recruiting.manage you can only open your own candidates. Ask a manager to reassign.
- No "Add lead" button – you lack recruiting.manage.

## Add a new driver lead

Path: HR › Recruiting (/hr/recruiting) › "Add lead" · Permission: recruiting.manage

What it is for: entering a driver who called, walked in or was referred.

Steps
1. Open HR › Recruiting and click "Add lead".
2. Fill "Full name" (required), "Phone" (required), "Email (optional)".
3. Choose "Source" (Instagram, Facebook, Referral, Phone call, Website, Job board, Walk-in and other recorded sources).
4. Under "Assigned to" choose "Automatic · next <name>" (the next recruiter in the HR rotation) or "A specific recruiter" and pick the "Recruiter".
5. Click "Add lead".

After saving: toast "Lead added" with "Assigned to <name>." or "No recruiter was eligible; it is unassigned." The lead appears in the "New Lead" column with next step "Contact driver". The Automatic preview is only informational; the server takes the actual turn when the lead is saved.

Why it won't work
- "Enter the full name" – name shorter than 2 characters.
- "Enter a 10-digit phone number" – phone has fewer than 10 digits.
- "Choose the recruiter" / "Choose the recruiter, or pick Automatic." – "A specific recruiter" chosen with nobody selected.
- "That phone number is already lead <number> (<status>). Open it rather than starting a second record." – a lead with this phone exists; open that lead instead.
- "This needs the recruiting manage permission." – you lack recruiting.manage.

## Public apply link and Instagram lead form (/apply/nwf-drivers)

Path: HR › Recruiting (/hr/recruiting) › More › Recruiting settings › "Links" · Permission: recruiting.view
Needs to change: recruiting.manage

What it is for: the short public form used in the Instagram bio and ads (for example /apply/nwf-drivers). A driver enters "Full name", "Phone number", "CDL driving experience", picks "Company driver", "Lease owner" or "Owner driver", ticks the consent to be contacted and presses "Apply now". It takes about 30 seconds and needs no documents.

Steps to share or manage links
1. HR › Recruiting › "More" › "Recruiting settings", then the "Links" section.
2. The "Instagram lead form" card lists each link with "Active" or "Off" and a copy button.
3. With recruiting.manage click "Manage links" to create a link ("Name", "Link address", "Short name" up to 12 characters shown as "Drive with …", "Record leads as", "Campaign", consent wording, privacy policy and logo addresses) or "Switch off" / "Switch on" an existing one.

After a driver applies: the application arrives as a New lead with its answers, source and campaign, assigned to the next recruiter in the HR rotation. A driver who applies again with the same phone and name keeps the recruiter who already has them; a different name on a known number becomes its own lead.

The full driver application is never public: each candidate gets a private link from their own page (see "Send consent and application links").

Why it won't work
- Driver sees "This application link is not active. Please contact the company directly." – the link was switched off or does not exist. Switch it on in Manage links.
- Driver sees "Too many applications from this connection. Please try again later." – rate limit for one connection.
- "The address /apply/<slug> is already taken. Choose another." – pick another link address.

## Recruiting stages and statuses explained

Path: HR › Recruiting (/hr/recruiting) · Permission: recruiting.view

A candidate's status is never typed in; it is read from their records. The status names, in order:
1. "New lead" – nobody has reached them.
2. "Called · no answer".
3. "Contacted".
4. "Prequalified" – prequalification answers recorded and passed.
5. "Consent sent" – consent link out, waiting for the driver.
6. "Consent received" – driver signed; Recruiting uploads MVR and PSP.
7. "Safety review" – sent to Safety, waiting for a decision.
8. "Application sent" – Safety qualified; application link out.
9. "Application received".
10. "Onboarding".
11. "Ready to hire" – every prerequisite met.
12. "Hired".
13. "Closed" – disqualified, withdrawn, or Safety said Not qualified.

Board columns group them: New Lead (New lead), Lead Screening (no answer, contacted, prequalified), Consent sent, Consent received, Safety Review, Application (sent/received), Onboarding & Costs, Ready to Hire, Disqualified. Dashboard stages are "New lead", "Consent pending", "Safety review", "Application pending", "Onboarding", "Hired", "Closed".

The "next step" shown on a card: "Contact driver", "Call again", "Send consent", "Waiting for consent", "Send to Safety", "Safety review" or "Safety follow-up", "Send application" or "Waiting for application", "Review application", "Start onboarding", "Onboarding", "Hire driver", "Driver profile", "No action".

Time in step and stuck candidates:
- Board cards show how long ago the candidate reached their current step.
- More › "Pipeline board" lists everyone by hiring stage with "<n> days in stage" and marks "overdue" (stuck) when a step exceeds its limit: new lead 1 day, contacted/prequalified 3, application 3, checks/documents 5, safety review 2, offer/ticketed 5, orientation 3, hired (waiting for first load) 7. Stuck people sort to the top.

## Move a candidate to the next step (status menu)

Path: HR › Recruiting (/hr/recruiting) › candidate page (/hr/recruiting/<id>) · Permission: recruiting.view
Needs to change: recruiting.manage

What it is for: changing where a candidate is. Click the status badge (on the board card or the candidate header) to open the status menu. Each row says what it would do; rows that cannot be used say why ("After the consent is signed", "After Safety approves", "Set when the driver signs", "When every prerequisite is met"…).

Available moves
- "Called · no answer" and "Contacted" – for a lead that is new or not answered. "Mark as contacted" is also on step 1.
- "Prequalified · Record answers…" – opens "Prequalify <name>": "23 or older", "Years holding a CDL", "Verifiable OTR experience (yr)", "Accidents, last 36 months", "Moving violations, last 36 months", "DUI, ever", "Endorsements held", "Pay preference", "Home state", "Earliest start"; press "Evaluate". The verdict comes from the company's rules in Admin → Settings.
- "Consent sent" – opens step 2 to make the consent link.
- "Safety review" – opens Send to Safety (only from Consent received).
- "Application sent" – sends the application link (only after Safety qualified).
- "Onboarding" – "Start onboarding", or "Review the application first".
- "Hired" – opens Hire driver (only from Ready to hire).
- "Closed · Disqualify…" (a lead) or "Closed · Withdraw…" (a candidate) – needs a reason; kept and audited.

Other actions under "More": "Prequalify…", "Disqualify lead…" ("Disqualify <name>", "Reason" required), "Drop from hiring…", "Reopen…" (a disqualified lead or candidate; "Note" required, at least 3 characters; it returns to the step it had reached). "Assigned to" in the header reassigns the recruiter (recruiting.manage). "Notes" saves a note with an optional follow-up date.

Why it won't work
- "Say why the lead is disqualified" – empty reason.
- "A <status> lead cannot be prequalified" – the lead is already dead or converted.
- "This lead has become a candidate; disqualify the candidate instead." – use "Drop from hiring…".
- "Only a disqualified lead can be reopened." / "Only a disqualified candidate can be reopened."
- "Pick today or a later date for the follow-up." – follow-up in the past.
- "A hired driver leaves through the roster, not hiring." – hired people cannot be withdrawn here.

## Rename a candidate (fix a misspelled name)

Path: HR › Recruiting (/hr/recruiting) › candidate page (/hr/recruiting/<id>) › pencil next to the name · Permission: recruiting.view
Needs to change: recruiting.manage

What it is for: correcting a candidate's or lead's name from the candidate page.

Steps
1. Open the candidate page.
2. Click the pencil next to the name ("Edit name").
3. Fix "First name" (required) and "Last name" (each at most 40 characters).
4. Click "Save" or press Enter. Esc or "Cancel" closes without saving. Toast: "Name changed".

What happens after: the name changes on the lead, the hiring case and the application at once, and on Safety's open check file if the person is not hired yet. The change is audited ("Name changed from … to …") and shows in the activity. For someone already hired, only Recruiting is renamed: "Renamed in Recruiting only. The driver profile is renamed in Drivers." Rename the driver on their Drivers profile.

Why it won't work
- No pencil: you lack recruiting.manage.
- "Enter the first name." – the first name is empty.
- "This candidate changed since you opened it. Reload the page and try again." – someone else changed the candidate; reload.
- "The name was not saved. Try again." – a network error.

## Send consent and application links (device-bound links)

Path: HR › Recruiting › candidate page (/hr/recruiting/<id>) › steps 2 "Send consent" and 5 "Send application" · Permission: recruiting.manage

What it is for: the driver signs the MVR, PSP and Clearinghouse consents (and sends the CDL front and answers the safety questions) through a private consent link; after Safety qualifies them they fill the application through a private application link.

Steps (same for both links)
1. Open the candidate, click step "Send consent" (or "Send application").
2. Click "Create link" (or "Create new link"; a new link stops the earlier one).
3. Click "Copy" and send it to the driver yourself, or use "Text to <phone>" / "Email to <email>" when available.
4. Click "Mark as sent". The card shows "Sent · <date>".

Rules
- Each link works for 14 days and opens on one device only: the first phone or computer that opens it keeps it. On another device the driver sees "This link was already opened on another phone or computer. Ask your recruiter for a new link." Make a new link to fix it.
- The address is shown only when made; the server keeps only a fingerprint. To send again, create a new link.
- Texts need texting consent: "Record the texting consent first" or "The candidate opted out of texts".
- When the driver signs, the candidate moves to "Consent received"; when they submit the application, to "Application received".

Why it won't work
- "This lead was disqualified; reopen it before sending a consent." / "...before sending an application."
- "The consent has already been signed and received."
- "This candidate is no longer in the hiring pipeline."
- Application link blocked: "The application is sent after the consent is signed and Safety approves it." or "The application is sent after Safety approves the candidate." (shown as "Waiting for Safety").
- "Create a link first" – Mark as sent before a link exists. "There is no live application link to mark as sent." / "There is no open consent link for this candidate. Make one first."
- "Email is not set up on this TMS. Copy the link and send it yourself."
- Driver sees "This consent link has expired. Please ask your recruiter for a new link." or "This consent link is not valid. Please ask your recruiter for a new link."
- Driver sees "Your consent was already received (reference <ref>). To change it, please contact recruiting."

## Send a candidate to Safety

Path: HR › Recruiting › candidate page › step 3 "Consent received" › "Send to Safety" · Permission: recruiting.manage

What it is for: after the driver signs the consent, Recruiting runs the MVR and PSP, files the reports and sends the file to Safety for a decision.

Steps
1. Open the candidate, step "Consent received". Check the signed consents, CDL front and the safety question answers.
2. Under "Screening reports" click "Upload report" for the MVR and the PSP ("Report file (PDF, JPG or PNG)", "Received on", then "Upload"). Optionally mark the result "Clear", "Findings" or "Prohibited". Clearinghouse queries are optional.
3. When the pill says "MVR and PSP on file · ready to send", click "Send to Safety", add a "Note for Safety (optional)" and confirm "Send to Safety".

After: toast "Sent to Safety"; the candidate moves to "Safety review" and appears on Safety › Hiring decisions under "Waiting for decision". Safety users are notified.

Why it won't work
- Button disabled, tooltip "Upload the MVR and PSP first" (or one of them). Server: "Upload the MVR and PSP reports first, then send to Safety."
- Button disabled, tooltip "Any Yes on the safety questions: disqualified per company hiring policy". Server: "Any Yes on the safety questions disqualifies this driver per company hiring policy; the file is not sent to Safety." A recruiter can write a "Comment on a Yes answer" and choose "Save and return to hiring" to bring the candidate back.
- "Send to Safety needs the signed consent first." / "The consent has not been received yet."
- "This candidate is already with Safety."
- "The review is decided; reports can no longer be added."

## Hiring decisions: Qualified, Not qualified, Insurance check

Path: Safety › Hiring decisions (/safety/hiring) · Permission: compliance.manage

What it is for: Safety's queue of candidates Recruiting sent, with the signed consents and the reports Recruiting filed.

Steps
1. Open Safety › Hiring decisions. Tabs: "Waiting for decision" and "Decided". Pick a candidate.
2. Read the consents and the reports.
3. Decide:
   - "Qualified" – toast "Qualified" with "Recruiting can now send the application." The candidate shows "Application sent" (next step "Send application") and Recruiting creates the application link on step 5.
   - "Not qualified" – enter "Why" (at least 3 characters) and confirm. The candidate is closed (disqualified with "Safety declined"), Recruiting is told, everything is kept.
   - "Insurance check" – asks the insurer; Recruiting sees "Safety is checking with insurance". Later click "Insurance response" and record "Approved — the insurer accepts the driver" or "Declined — the insurer does not accept the driver" (a decline needs "What the insurer said").

Why it won't work
- "Qualified" disabled with "Qualified needs a reviewed MVR and PSP report." Server: "Approval needs: MVR report: not on file; PSP report: no result recorded" (lists what is missing).
- "Waiting for the insurance answer: record it first." – record the insurance response before Qualified.
- "The insurer declined this driver."
- "A Clearinghouse result shows a prohibition: this candidate cannot be qualified."
- "Say why." – Not qualified or Needs follow-up without a note.
- "The review is already decided." / "Someone else changed this review. Reload and try again."
- Menu item missing – you need compliance.manage.

## Review the application and run onboarding & costs

Path: HR › Recruiting › candidate page › steps 6 "Application received" and 7 "Onboarding & costs" · Permission: recruiting.manage

Steps
1. Step "Application received": open the application PDF and documents, then click "Review application" (it becomes "Reviewed by <name>").
2. Click "Start onboarding". The standard checklist opens: "Documents verified", "Drug test result", "Previous employer checks", "Orientation", "Arrival" (all required). Add more with "Add an onboarding task" (Task, "Required for the hire").
3. Step "Onboarding & costs", tab "Checklist": update each task's "Status" and "Due". A done drug test needs its result. A waived task needs a reason.
4. Tab "Travel & costs": "Add a booking" (Type flight, hotel or ground; dates; "Paid by"; "Booking reference") – the price is recorded as spent. "Add expense" (Category, "Amount ($)", "Date", "Vendor", "Paid by", "Whose cost", "Driver's agreement"). Expenses are saved as planned; approval books them; payment is recorded separately.

The yellow box "Before Ready to hire" lists what still blocks the hire.

Why it won't work
- "Start onboarding" disabled, "Review the application first". Server: "Review the application before starting onboarding."
- "No application has been received yet."
- "Start onboarding first." – adding a task before onboarding started.
- "Say why the task is waived." / "Record the drug test result (for example Negative)."
- "Arrival is before departure." / "Check-out is before check-in."
- "A cost the driver owes needs the driver's recorded agreement before it is approved."
- "Approve the cost before recording its payment." / "This cost is voided."

## Hire a driver (the only way a candidate becomes a driver)

Path: HR › Recruiting › candidate page › step 8 "Ready to hire" · Permission: recruiting.manage

What it is for: hiring creates the driver profile under the same driver id the candidate had; documents, signatures, costs and audit stay with them. There is no other way to turn a candidate into a driver.

The checklist (all must be green): "Safety cleared", "Pre-employment Clearinghouse full query (optional)" (only a prohibited result blocks), "Application reviewed", "Required documents verified" (CDL front, CDL back, medical card), "Drug test result verified", "Other required checks completed", "Orientation and arrival completed", and "Not on hold" when a hold exists.

Steps
1. Open step "Ready to hire" (or click "Hire driver" on a Ready to Hire board card).
2. Click "Hire driver". Fill "Start date" (required), "Dispatcher" (required), "Driver type" (Company driver, Lease operator, Owner operator), "Pay plan" ("Per mile ($)" or "% of linehaul") and the rate (required).
3. Click "Hire driver". Toast "Driver hired: <name> is driver <number>."
4. Step 9 "Driver profile" shows "Open driver profile".

Other buttons: "Hold" (reason required; nothing moves until "Release hold") and "Withdraw" (reason required; candidate leaves hiring, everything kept).

Why it won't work
- "Hire driver" disabled, "Not ready: see the checklist". Server: "Not ready to hire. <missing items>".
- "This candidate is no longer in the hiring pipeline."
- "The CDL or medical card expiry is not on file; the roster cannot be opened without them."
- "The application has no two-letter state for the address or the CDL; correct the application first."
- "Driver <number> already belongs to someone else."
- "Say why the candidate is on hold."

## Cost per hire and recruiting analytics

Path: HR › Recruiting (/hr/recruiting) › More › Analytics · Permission: recruiting.view

What it is for: lead sources, recruiter results, conversion, and hiring cost.

Steps
1. HR › Recruiting › "More" › "Analytics"; choose the period.
2. Top figures: "Leads", "Hired", "Conversion". Panels "Lead sources" and "Recruiter results".
3. Open "Funnel, cost per hire and retention" for "Leads", "Candidates", "Hires", "Cost per hire", "Funnel by source", "Time in stage" and "Hiring costs" ("Direct cost, total", "True cost, total", "True cost per hire").

How it is counted: leads are those added in the period; hires and cost per hire use hires whose hire date is in the period; direct cost is everything charged to those hires and their leads; true cost adds every cost in the period plus campaign spend. A figure that cannot be computed shows a dash, for example "No hires in this period".

Per candidate costs: candidate page › "More" › "Costs" ("Total recorded", "Cost entries", "Cost history", "Add cost", void with a reason). Screening reports are priced automatically from company settings; travel, lodging, orientation pay and bonuses come from their records. Campaign costs per lead and per hire are under More › Campaigns.

## HR rotation: who gets new leads

Path: HR › Recruiting (/hr/recruiting) › More › Recruiting settings › "HR assignment" · Permission: recruiting.view
Needs to change: users.edit (administrator)

What it is for: new online and hand-added leads go to the next recruiter in order. Old leads are never moved.

Who takes turns: an account that is active, has an active membership in the company, and is linked to an employee who is not terminated and whose position names recruiting (Recruiter, Senior Recruiter…). New eligible accounts join at the end; excluded or ineligible ones are skipped and keep their place.

Steps
1. Open More › "Recruiting settings" › "HR assignment".
2. "Active HR rotation" lists recruiters with "Takes turns", "Excluded" or "Skipped · <reason>" and marks who is next.
3. Administrators reorder with the up/down arrows and use the switch to exclude or include a person.
4. To add a recruiter, link their account to their employee record in Administration › Users.

Rules: a retried or duplicate application keeps its recruiter and takes no turn; a lead that applies again keeps whoever already has it.

Why it won't work
- "Only an administrator can change the order or exclude someone." / "Only an administrator can change the HR rotation." – you need users.edit.
- "Nobody is taking leads" – no eligible recruiter; new leads arrive unassigned.
- "The rotation changed while you were editing it. Reload and try again."
- Skip reasons: "Account disabled", "Employee terminated", "Position is <position>", "Account no longer linked to the employee", "Employee record not found".

## Onboarding plans page (/hr/onboarding)

Path: /hr/onboarding (not in the menu; reached from a hire) · Permission: onboarding.view
Needs to change: onboarding.manage

What it is for: the employee onboarding plans: "Everything that has to happen before a new hire can do the job." A plan appears when a driver is added on the roster or a candidate is hired. Driver candidates in hiring use the candidate's "Onboarding & costs" step instead.

Steps
1. Counters: "Onboarding", "Starting soon", "Overdue", "Blocked", "Completed".
2. "Start onboarding" creates a plan for an existing employee ("Employee", "Owner", "Start date"). "Add driver" goes to the driver roster form. "Templates" shows the onboarding templates.
3. Open a plan to see items; "Add onboarding item" ("Title", "Category", "Owner", "Due date", "Notes").

## Work a Driver Relations request

Path: Driver Support › Driver Relations (/driver-relations) · Permission: driver_relations.view
Needs to change: driver_relations.contact

What it is for: every request drivers send from the Driver Care page, with a clear owner and a real follow-up. The red alert ("Awaiting contact") is cleared only by a recorded contact with a note.

Steps
1. Open Driver Support › Driver Relations. Use the topic cards ("Driver Referral", "Complaint & Feedback", "Reimbursement", "Pay & Statement Help", "Compliance", "Management Call Request"), the status tabs ("All", "Awaiting contact", "Contacted", "Resolved") and "Search driver, truck or request…".
2. Click a request. Read "Driver's message", the details and any "Receipts" (click "Open").
3. Set "Assigned owner" and "Contact method".
4. Write in the note box, then:
   - "Mark Contacted & save note" (or "Record another contact") – clears the alert.
   - "Record attempt" – no answer or voicemail; the alert stays.
   - "Resolve with this note" – only after a contact.
   - "Add note only".
   - "Log driver message" – a new message from the driver; the request needs contact again.
   - "Reopen request" on a resolved request (reason required).
5. "Linked records": verify and link the driver and truck, or enter the "Accounting reimbursement id" for a reimbursement. Driver Relations never pays money; Accounting records the reimbursement first.

Why it won't work
- "Write what was discussed before marking contacted." / "Write a resolution note first." / "Write why it is being reopened." / "Write a note first."
- "Record contact with the driver before resolving. The alert stays until contact is recorded."
- "This request is resolved. Reopen it first." / "This request is already resolved." / "Only a resolved request can be reopened."
- "That person cannot work Driver Relations requests in this company." / "This request is confidential; that person cannot see confidential requests."
- "Only a reimbursement request links to an Accounting reimbursement." / "No such reimbursement in Accounting. Accounting records it first; then link it here."
- "You can read this request. Recording contact needs the Driver Relations contact permission."

## Driver Care page (/care/nwf), confidential complaints and receipts

Path: Driver Support › Driver Relations (/driver-relations) › "Driver Care link" · Permission: driver_relations.view
Needs to change: driver_relations.manage

What it is for: the public page drivers open (for example /care/nwf) to send a request without logging in. Each request becomes a Driver Relations request with a reference number the driver sees ("Your reference: …").

Driver's forms: "Refer a Driver" (referral name and phone; also creates or links an HR lead in Recruiting with source driver referral), "Complaint & Feedback", "Reimbursement" (amount paid, optional load number, up to 3 receipt files), "Pay & Statement Help" (week starting), "Compliance" (CDL, Medical card, Other), "Management Call Request" (topic and preferred time; a request, not a booked call).

Confidential: Complaint & Feedback and a management call about "Confidential concern" are visible only to holders of driver_relations.confidential, in every list, count and file. Others see "Confidential: Driver Relations staff only".

Receipts: photos (JPG, PNG, HEIC) or PDF, up to 10 MB each and 20 MB together, maximum 3 files.

Managing links: click "Driver Care link", "Copy" an address, "Switch off"/"Switch on", or create a "New link" ("Link name", "Address" /care/…, "Create link").

Why it won't work
- Driver sees "This Driver Care link is not active. Please call your dispatcher or the office." – link switched off.
- "No Driver Care link yet. Drivers cannot send requests until one exists."
- "The address /care/<slug> is already taken. Choose another."
- Driver file errors: "Each file can be up to 10 MB.", "All files together can be up to 20 MB.", "Attach a photo (JPG, PNG, HEIC) or a PDF.", "That file is empty."
- Driver form errors: "Enter your full name.", "Phone number is required.", "Enter the amount you paid.", "Choose a topic.", "Choose what you need help with."

## Attendance: record time and resolve exceptions

Path: Quality › Attendance (/hr/attendance) · Permission: attendance.view
Needs to change: attendance.manage / attendance.approve

What it is for: office workforce time and exceptions (a driver's hours of service are a separate safety record).

Steps
1. Pick "Summary for" date. Counters: "Present today", "Absent", "Late", "On leave", "Missing punch", "Overtime", "Open exceptions".
2. "Add entry": "Employee", "Date", "Status", "Clock in", "Clock out", "Break (minutes)", then "Save entry".
3. Exceptions are detected automatically: "No clock in", "No clock out", "Late arrival", "Early departure", "Excessive hours", "Unapproved overtime". Click the exception, write "What was done about it", press "Resolve". Correcting the punches clears it on its own.
4. Click "Approve" on the row.

Why it won't work
- "<name> already has an entry for <date>. Edit it rather than adding a second one."
- "Clock out must be after clock in"
- "Resolve the exception on this day before approving it."
- "There is nothing outstanding on this day" / "Say what was done about it"
- "That employee is not on the workforce"

## PTO: time-off requests, decisions and balances

Path: Quality › PTO (/hr/pto) · Permission: pto.view
Needs to change: pto.create (submit), pto.approve (decide), pto.manage (types, balances)

What it is for: requests, approvals and balances; every hour is a ledger entry.

Steps
1. Counters: "Pending requests", "Hours awaiting decision", "Approved this month", "Upcoming", "Off today".
2. No types yet? Click "Add PTO type" ("Name", "Kind", "Accrual per period", "Period", "Maximum balance (optional)", "Allow the balance to go negative").
3. "New request": "Employee", "PTO type", "From", "To", "Hours", "Reason (optional)", then "Submit request".
4. To decide, click "Decide" on the row, choose the "Decision" (approved, rejected or cancelled), add "Note (optional)" or "Reason (required)" for a rejection, then "Confirm". "Approve even if it takes the balance negative" records an override.

Warnings saved for the approver: overlapping requests, more than 15 days away, 3 or more others off in the same department, attendance already recorded.

Why it won't work
- "<n> hours more than the <x> available under this policy." – blocks unless the type allows negative balances; on approval "... Approve anyway only if policy allows it."
- "A rejection must say why — the employee is owed a reason."
- "A <status> request cannot become <status>"
- "The end date cannot be before the start date"

## Performance: goals, reviews and cycles

Path: Quality › Performance (/hr/performance) · Permission: performance.view
Needs to change: performance.manage

What it is for: goals, reviews and action plans across the workforce. Private feedback is visible only with performance.manage.

Steps
1. Counters: "Reviews due", "Reviews completed", "Goals at risk", "Goals completed", "Without goals", "Open action plans". Tabs "Goals" and "Reviews".
2. "New cycle" ("Name", "Kind", "Period start", "Period end", "Reviews due", "Create cycle").
3. "Set goal" ("Employee", "Goal", "Category", "How it is measured", "Target", "Unit", "Start", "Due", "Cycle", "Description"). Update a goal with "Update" (status not started, in progress, at risk, completed, cancelled).
4. "Start review" ("Employee", "Reviewer", "Cycle", "Period start", "Period end", "Open review"). In the review set "Overall rating" (1 Needs significant improvement to 5 Exceptional), "Summary", "Strengths", "Development areas", "Manager feedback"; "Save draft", then "Submit", "Acknowledge", "Complete". A completed review shows "Reopen" with "Reason for reopening (required)".

Why it won't work
- "A review cannot be submitted without a rating."
- "A completed review cannot be edited. Reopen it first, with a reason."
- "A numeric goal needs a target" / "The due date cannot be before the start date" / "The period must end after it starts"
