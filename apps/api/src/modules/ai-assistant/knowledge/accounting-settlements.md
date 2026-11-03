# Accounting: Settlements, driver statements and Staff Payroll

Settlements is where drivers and truck-owning vendors are paid for one week of delivered loads. Each week, for each kind of payee, Accounting checks the setup, creates the week's statements, reviews and approves each one (approval freezes it; it can be reopened until the payment is recorded), then emails the PDFs, exports the payment file, records the payment and closes the week. Every figure is calculated on the server. Office staff (dispatchers, salaried employees) are paid on a separate page, Staff Payroll, never through Settlements.

## Settlements page: what it is and how it is laid out

Path: Accounting › Settlements (/accounting/settlements) · Permission: accounting.view
Needs to change: accounting.edit (bank details need accounting.bank)

The Settlements page pays drivers and vendors for one week of delivered loads. You work down the page in four numbered steps.

Steps
1. Pick the week with the week picker at the top right: "Previous week", "Next week" or "This week". It shows the week's dates and the "Payday". Everything below follows the picked week. Past weeks that already have statements can also be chosen from "Jump to a past week".
2. Pick who is being paid with the tabs: "Company drivers", "Lease & owner operators" or "Vendors". The line under the tabs says which loads count in this week: "A load counts in this week if it was completed from <Mon … 12:00 PM> up to <Mon … 12:00 PM ET> (Monday noon to Monday noon, US Eastern). Accounting can set a load's pay date on the load." The week picker shows the same window, for example "Mon Oct 12, 12:00 PM – Mon Oct 19, 12:00 PM ET".
3. Step 1 "Check before paying": lists anything that can make a statement wrong (incomplete Accounting settings, drivers whose pay setup needs a look, loads from earlier weeks never paid).
4. Step 2 "Create this week's statements": the "Create statements" button (it reads "Update draft statements" once the week exists).
5. Step 3 "Review and approve": the week's totals ("To pay out", "Carried to next week", "Statements"), status filters ("All", "Waiting for approval", "Approved", "Paid"), the statements table and "Approve selected".
6. Step 4 "Send and pay": "Email PDFs", "Export" (PDF statements (ZIP), Excel, CSV, Print this page) and "Close the week".

Click any row in step 3 to open the statement in a side panel.

Statement statuses (symbol + word): "Draft · not approved", "Needs a look" (the statement has exceptions), "Approved · not paid" (locked), "Paid".

Why it won't work
- The "Create statements", "Approve selected", "Email PDFs" and "Close the week" buttons are missing: your role lacks accounting.edit. Ask an Accounting administrator.
- "Statements" shows "No statements this week.": statements have not been created for this week and tab yet; use step 2.

## Company drivers, lease operators, owner operators and vendors

Path: Accounting › Settlements (/accounting/settlements) · Permission: accounting.view

Settlements has three tabs, and each driver lands on exactly one of them according to the contract type on their financial profile.

- "Company drivers" (CD): drivers employed by the company, paid per load or per mile. By default a company driver's fuel and tolls are company costs, not deducted.
- "Lease & owner operators" (LO & OO): lease operators and owner operators, paid a share of each load. By default their fuel and tolls are deducted. A lease plan (tractor lease, maintenance fee, dispatch fee, fixed charges) can be added on their profile.
- "Vendors" (VT): truck owners. One statement per vendor covers all of their trucks: the vendor's share of each truck's loads, less driver pay, fuel, tolls and other vendor-recoverable costs. Use "Which vendor owns which truck" on the Vendors tab to add a truck → vendor arrangement ("Vendor", "Truck", "From", "Share %", then "Add"). Arrangements are dated, so loads are assigned by the date they ran.

The contract type is changed on the driver's page: Operations › Drivers › driver › "Financial account" tab › "Edit" (or "Set up profile") › "Contract type". A change is effective-dated and never rewrites a statement already computed.

Extra rules
- If Accounting settings say LO/OO are paid only once funded, an LO/OO load whose invoice is not funded is left off the statement with "Not funded yet (pay on funding only)".
- A driver with no financial profile defaults to the contract type on the roster, or CD.

Why it won't work
- "Pay-on-funding-only is not configured for LO/OO (Settings › Accounting).": approving an LO/OO statement needs the setting "LO/OO paid only after funding?" decided. Set it in Accounting › Accounting › Settings tab.
- Vendor statement exception "Unit <number>: no vendor percentage on the arrangement and no company default.": give the arrangement a "Share %" or set "Vendor default share" in Accounting settings.

## How to create this week's driver statements

Path: Accounting › Settlements (/accounting/settlements) › step 2 "Create this week's statements" · Permission: accounting.view
Needs to change: accounting.edit

Creating statements collects every load delivered in the week and works out what each person is owed. It is safe to repeat: approved statements are never changed.

Steps
1. Open Accounting › Settlements and pick the week with the week picker.
2. Pick the tab: "Company drivers", "Lease & owner operators" or "Vendors".
3. Look at step 1 "Check before paying" and fix what you can (see "Settlement setup missing items" and "Why a driver is blocked from a statement").
4. Optional: in step 2 click "Show who and which loads" to preview each driver, truck, loads, "Load revenue", "Estimated pay" and "Can be paid?".
5. Click "Create statements". A message says "Statements created for <dates>" and that nothing is approved or paid yet.
6. After a change (new load, deduction, fix to a pay plan) click "Update draft statements" to recalculate drafts. Approved and paid statements stay as they are.
7. If step 1 says loads "from an earlier week never made it onto a statement", click "Pay them this week" to include them.

What happens after: one statement per driver for the week (number like ST-20261012-ABC123), status "Draft · not approved", or "Needs a look" when it has exceptions. A driver appears even without loads if they are active or had charges that week.

Why it won't work
- "Create statements" is greyed out with the tip "Complete the settings in step 1 first": the cutoff time source or cutoff clock is not confirmed in Accounting settings.
- "Cutoff time source is not configured (Settings › Accounting): which timestamp decides the week. Batches wait until it is chosen.": set "Cutoff reads" in Accounting › Accounting › Settings tab.
- "The cutoff clock (America/New_York) has not been confirmed in Settings › Accounting. Batches wait until it is.": tick "I confirm the settlement cutoff clock is …" in Accounting settings and save.
- "<KIND> <date> is closed.": that week was already closed; nothing more can be created for it.
- "Only Accounting can change settlements.": your role lacks accounting.edit.

## Settlement setup missing items

Path: Accounting › Settlements (/accounting/settlements) › step 1 "Check before paying" · Permission: accounting.view
Needs to change: accounting.edit (settings are saved on Accounting › Accounting › Settings tab, which needs accounting.overview to open)

Step 1 shows "All clear" or "<n> to check". Under "Accounting settings are incomplete" it lists:

- "Cutoff time source": which timestamp (actual delivery or status update) decides the week. Blocks creating statements.
- "Cutoff clock": the company time zone has not been confirmed as the settlement clock. Blocks creating statements.
- "Team base-mileage split": only team loads on mileage pay are affected; it does not block creating statements, but such a statement gets the exception "Team base-mileage split is not configured (Settings › Accounting)."

Steps to fix
1. Click "Open Accounting settings" (goes to Accounting › Accounting, "Settings" tab).
2. In the "Settlements" box set "Cutoff reads" ("Actual delivery time" or "Status update time"), tick "I confirm the settlement cutoff clock is …", set "Team base-mileage split" ("Each driver full miles" or "Split 50/50"), and if needed "LO/OO paid only after funding?" and "Vendor default share, basis points".
3. Click "Save settings". Return to Settlements; step 1 updates.

Step 1 also lists "Drivers whose pay setup needs a look" (only drivers being paid this week) with a "Fix pay setup" button, and loads from earlier weeks that were never on a statement.

Driver pay-setup issues shown there
- "Pay rate is unclear — confirm it": the roster percentage could be read two ways (e.g. 0.3 = 0.3% or 30%).
- "Confirm what the percentage is taken from": an old linehaul-basis plan needs a reviewed decision.
- "Pay plan has not been reviewed": no financial profile saved yet; the roster figure is used.
- "Starting debt balance not confirmed" / "Starting escrow balance not confirmed".
- "No bank details — cannot be paid".
- "No email — statement cannot be emailed".

Why it won't work
- "Open Accounting settings" opens nothing useful: the Accounting overview page needs accounting.overview. Ask someone who has it.
- "Fix pay setup" is missing: you lack accounting.edit.

## Why a driver is blocked from a statement

Path: Accounting › Settlements (/accounting/settlements) › step 2 "Show who and which loads" › "Can be paid?" column · Permission: accounting.view

The "Can be paid?" column shows "Yes" or the first blocker (hover for all). Open statements also show "Check before approving" (side panel) or "Exceptions block approval" (full page). Every message:

Pay plan
- "Pay plan not reviewed": no saved financial profile. Fix: "Fix pay setup" or driver › "Financial account" › "Set up profile" › "Save profile".
- "No pay plan on file for this driver." / "No pay profile in force for this driver: nothing can be paid until one is set.": save a profile effective on or before the week.
- "Loaded pay plan is blank." / "No loaded pay plan on the profile in force.": choose a "Loaded pay plan" and rate.
- "Rate 0.3% needs confirmation: it may have been meant as 30%.": on the Financial account tab click "It is …" for the right reading, or tick "Confirm this rate … as reviewed" in the profile.
- "Opening debt not reconciled (final net waits; earnings preview does not)": enter "Opening debt ($)" and tick "Opening debt reconciled".

Loads and settings
- "Team base-mileage split is not configured (Settings › Accounting).": set it in Accounting settings.
- "<charge>: Include in driver statement? not decided.": an accessorial (detention, lumper…) on the load needs Accounting's decision on the load's billing review.
- A load listed as "Excluded" with "Load is <status>" (not delivered/closed/TONU) or "Not funded yet (pay on funding only)" (LO/OO, unfunded invoice).

Deductions and balances
- "<n> transaction(s) this week still pending approval.": approve or void them on the driver's "Financial account" › Transactions.
- "Escrow opening balance is not reconciled: escrow is not deducted until it is.": enter "Escrow opening balance ($)" and tick "Escrow opening reconciled".

Lease plans
- "No odometer reading for <unit> by <date>: the tractor lease tier cannot be figured." and "No odometer readings for <unit> at both ends of the week: the maintenance fee cannot be figured.": the truck has no ELD odometer reading for the week. Press "Enter odometer" under the warning and type the readings (see "Enter the odometer from a statement"), or wait for readings, then "Update draft statements".

Approval
- "Resolve the exceptions first: …": any of the above blocks approval.
- "Pay-on-funding-only is not configured for LO/OO (Settings › Accounting).".

After fixing, click "Update draft statements" in step 2.

## Review a statement and add a deduction or reimbursement

Path: Accounting › Settlements (/accounting/settlements) › step 3 › click a statement row · Permission: accounting.view
Needs to change: accounting.edit

The side panel shows a driver statement line by line: "To pay out", "Earned" (each load with route and rate), "Reimbursements (added to pay)", "Taken off (deductions)" (fuel, tolls, advances, charges, recurring, repayments, escrow, lease charges), "Owed by the driver before → after this week" and "To pay out". While it is a draft you can add items.

Steps to add a deduction
1. Click "Add deduction".
2. Fill "What for" (Damage, Fine or ticket, Equipment, Uniform, Other), "Amount", "Description" (what the driver reads; needed for Other), "Spread over" (weeks, 1 = all this week), "Why (kept on record)" (at least 3 characters).
3. Click "Add $… deduction". It goes on the driver's account, taken as far as this week's pay allows; the rest stays owed for next week.

Steps to add a reimbursement
1. Click "Add reimbursement".
2. Fill "Category", "Amount the driver paid", "Description"; click "Attach receipt" or fill "Why there is no receipt".
3. Click "Add and approve $…". It is recorded and approved in one step and appears in the Reimbursements list.

To remove a deduction added by hand (nothing taken yet), click its bin icon; it stays on the account as void with the reason.

Links at the bottom: "Open full statement", "PDF", "Driver's financial account".

Why it won't work
- No add buttons: the statement is approved ("Approved. Record the payment to lock it; until then it can be reopened." Press "Reopen to edit" first) or paid ("Paid · locked. A correction goes on next week's statement."), or you lack accounting.edit.
- "Add deduction" button stays grey: amount is 0, the reason is shorter than 3 characters, or "Other" has no description.
- "Not added" with "That charge is already on file (…)": the same charge (kind, date, amount, description) already exists.
- No bin icon on a deduction: only hand-added charges with nothing yet recovered can be removed.

## Approve a statement and why approval is refused

Path: Accounting › Settlements (/accounting/settlements) › step 3 · Permission: accounting.view
Needs to change: accounting.edit

Approving freezes a statement: from then on it cannot change unless Accounting presses "Reopen to edit" (possible until the payment is recorded; see "Reopen an approved statement to edit it"). Once it is paid, corrections go on next week's statement. Approval records the deductions it took, recurring and lease charges, the escrow deposit and any amount carried forward, and posts to the ledger.

Steps
1. Open Accounting › Settlements, pick the week and the tab.
2. Either tick statements and click "Approve selected (n)", or open a statement and click "Approve this statement" (side panel) or "Approve" (full statement page).
3. Success says "Approved and locked". The status becomes "Approved · not paid".
4. When every statement is approved, step 3 shows "All approved".

Notes
- "Approve selected" only approves ticked statements in "Draft · not approved". A statement in "Needs a look" has exceptions and must be fixed first.
- If deductions are more than the pay, "To pay out" is $0 and the rest shows as "owes $… → next week"; it is carried to next week automatically.

Why it won't work
- "Resolve the exceptions first: …": the statement has exceptions; see "Why a driver is blocked from a statement", fix, then "Update draft statements".
- "Pay-on-funding-only is not configured for LO/OO (Settings › Accounting).": decide "LO/OO paid only after funding?" in Accounting settings.
- "<ST-…> is already approved." / "… is already paid.": nothing to do.
- "<period> is closed. Raise an adjustment in an open period instead of posting into a closed one.": the ledger month is closed; reopen it on Accounting › Accounting › Periods or ask Accounting.
- "That event has already been posted (…); posting it again would double the money.": it was already posted.
- "Approve" on the full page is greyed out: the statement has exceptions.
- "Only Accounting can change settlements.": you lack accounting.edit.

## How to make a driver statement PDF

Path: Accounting › Settlements (/accounting/settlements) · Permission: accounting.view (a single driver statement PDF also opens with drivers.view)

Every statement, including a draft, can be downloaded as a PDF. A draft PDF is marked DRAFT on every page; an approved or paid PDF is the frozen copy that is emailed and exported.

Steps (one statement)
1. Open Accounting › Settlements, pick the week and the tab ("Company drivers", "Lease & owner operators" or "Vendors").
2. If step 3 is empty, click "Create statements" in step 2 first.
3. Click the driver's row in step 3. In the side panel click "PDF" (it downloads as <statement number>.pdf).
4. Or click "Open full statement": the page shows a "PDF preview" on the right and a "PDF" button at the top to download it.

Steps (many at once)
1. In step 3 tick the statements (or none for the whole week).
2. In step 4 click "Export" › "PDF statements (ZIP)". One PDF per statement in a ZIP file.

To send PDFs by email see "Email statements, export the payment file and close the week".

Why it won't work
- The PDF says DRAFT: the statement is not approved yet. Approve it to get the final copy.
- "The PDF could not be loaded" with "Retry": a network or server error; click "Retry".
- "Needs accounting.view or drivers.view.": your role can't open statements.
- "Vendor statements need accounting.view.": vendor PDFs need accounting.view.
- "Statement … is not on file.": the link is old or the statement belongs to another company.
- "Nothing to export.": no statements for that week/selection.

## Email statements, export the payment file and close the week

Path: Accounting › Settlements (/accounting/settlements) › step 4 "Send and pay" · Permission: accounting.view
Needs to change: accounting.edit (email, close)

Step 4 sends each person their own statement, exports files for the bank or records, and closes the week. Emailing never marks anything paid.

Steps
1. In step 3 tick the statements to send or export.
2. Click "Email PDFs (n)". The "Batch delivery" window lists each statement as "Ready" or blocked ("Missing email", "Not approved (draft PDF)"). Click "Send n". The result is "Queued for sending", or "Logged, not sent" when the server has no email transport configured.
3. Click "Export (n)" (or "Export all" with nothing ticked) and choose "PDF statements (ZIP)", "Excel" or "CSV". Excel/CSV columns: Statement, Party, Kind, Period start, Period end, Pay date, Status, Gross, Deductions, Escrow, Net, Payable, Carry.
4. Pay people from the bank. Record each payment on the statement's full page with "Record payment" (see "Record a statement payment and bank details").
5. When every statement is approved, click "Close the week". Toast: "Week closed".

Payroll (ADP) is not connected, and there is no "Send to ADP" button any more (it was removed from the statement panel on 2026-10-21). Pay each person from the bank, then press "Record payment" on the statement with the bank reference. Bank details on the payee are optional while ADP is not connected.

Why it won't work
- "Email PDFs" greyed with "Tick statements in step 3 first".
- A row is "Missing email": the driver (Drivers profile) or vendor has no email.
- "Not approved (draft PDF)": approve the statement first.
- "Close the week" greyed with "Approve every statement first", or "<n> statement(s) are not approved yet.".
- "Nothing to export.": nothing for the week or the selection.

## Record a statement payment and bank details

Path: Accounting › Settlements (/accounting/settlements) › statement › "Open full statement" (/accounting/settlements/<id>) · Permission: accounting.view
Needs to change: accounting.edit (payment); accounting.bank (bank details)

Approval is not payment. A statement becomes "Paid" only when the payment is recorded with the bank's reference.

Steps to record a payment
1. Open the statement's full page ("Open full statement" or "Open statement").
2. Click "Record payment" (shown only when the status is approved).
3. Fill "Paid on", "Method" (ACH, CHECK, WIRE, CASH) and "Bank / ADP reference" (required).
4. Click "Record". Toast "Payment recorded". The statement shows "Paid", the payment is posted, and reimbursements on it become paid.

Bank details (payee)
1. In the statement side panel find "Payee / Payment details" and click "Edit" (accounting.bank only).
2. Fill "Legal / business name", "Account type", "Routing number", "Account number", "Reason"; click "Save". Numbers are sealed and shown only as the last four digits.
3. Click "Verify". Until then it reads "Not verified — no payout until verified".

Why it won't work
- No "Record payment" button: the statement is not approved yet, or you lack accounting.edit.
- "Record" greyed: "Bank / ADP reference" is empty.
- "<ST-…> is draft; only an approved statement is paid.".
- A closed ledger period message ("… Raise an adjustment in an open period …"): the payment date is in a closed month.
- No "Edit" for payee: needs accounting.bank.

## Driver financial account: profile, pay plan, charges

Path: Operations › Drivers (/drivers) › driver › "Financial account" tab · Permission: drivers.view or accounting.view
Needs to change: accounting.edit

Each driver has one financial account: their pay profile, earnings per load, every charge and recovery, debt and escrow. Settlements read everything from here.

What you see: tiles "Earned, not settled", "Outstanding debt", "Escrow balance", "Pending deductions", "Approved, unpaid"; the "Expense responsibility" box (Deduct fuel, Deduct tolls, Approved advances, Recurring deductions, Escrow enabled); sub-tabs "Overview", "Earnings", "Transactions", "Debt", "Escrow", "Company costs", "History".

Steps: set up or change the pay profile
1. Click "Set up profile" (no profile yet) or "Edit".
2. Fill "Contract type" (CD/LO/OO), "Effective from", the switches, "Loaded pay plan" and "Loaded rate" (percent: 30 means 30%), "Empty pay plan"/"Empty rate", lease charges, "Escrow target ($)", "Escrow per settlement ($)", "Escrow opening balance ($)" + "Escrow opening reconciled", "Opening debt ($)" + "Opening debt reconciled", "Reason for the change".
3. Click "Save profile". Earlier statements keep their terms.

Steps: add a charge
1. Click "Manual charge". "Type": Charge (driver owes), Advance, Reimbursement (credit), Adjustment (credit), Escrow deposit, Escrow refund, Escrow offset against debt (authorised).
2. Fill "Amount (USD)", "Date", "Description", "Reason"; optional "Installments" (recover over that many settlements) and "Approval required".
3. Click "Save" (or "Send for approval"). Approved charges are taken on the next statement.

Steps: recurring deduction
1. Click "Recurring deduction"; fill "Category", "Label", "Cadence", "Amount ($)", "Starts", "Ends", "Installment total ($)", optionally "Charge in weeks with no loads (LO/OO fixed charges)". Click "Save".

On Transactions, a pending item has "Approve"; an approved one "Dispute"; a disputed/paused one "Resume".

Why it won't work
- "Only Accounting can change a driver's financial account.": needs accounting.edit.
- "The profile changed since you read it (version n).": reload and save again.
- "That charge is already on file (…)".
- "An applied charge cannot be voided; post an adjustment instead.".

## Deductions, escrow, advances and carried-forward debt

Path: Operations › Drivers (/drivers) › driver › "Financial account" tab, and Accounting › Settlements (/accounting/settlements) · Permission: accounting.view or drivers.view
Needs to change: accounting.edit

How a statement takes money off, in order:
1. This week's fuel, tolls and approved advances, if the profile switches "Deduct fuel", "Deduct tolls", "Approved advances" are on (default: on for LO/OO, off for CD; company-cost items are never deducted). Pending, disputed or paused items are not taken.
2. Lease charges (lease plans only).
3. Refunds of deductions reversed earlier (paid back as a negative line).
4. Recurring deductions, if "Recurring deductions" is on.
5. Repayment of older debt, oldest first, from what is left (lines read "Repayment" with charged / already deducted / remaining).
6. Escrow, if "Escrow enabled": up to "Escrow per settlement" until the target is reached.

If deductions exceed pay, "To pay out" is $0 and the difference is "Carried to next week" as debt. Nothing is lost.

Escrow and debt are separate balances. Escrow is not used to pay debt unless Accounting records "Escrow offset against debt (authorised)" with "Manual charge".

Advances: import or add with "Manual charge" › "Advance". Imported advances never count in expense totals; they reach the driver's account.

Installments: a charge with "Installments" or "Spread over" weeks takes an equal part each week.

Why it won't work
- Escrow not deducted: "Escrow opening balance is not reconciled: escrow is not deducted until it is." Enter the opening balance and tick "Escrow opening reconciled".
- Debt shows "not confirmed" / "unknown (not reconciled)": opening debt not reconciled on the profile.
- A charge isn't taken: it is pending approval, disputed, paused, or void.
- "This charge is already fully deducted." / "This charge was cancelled." / "At most $… is still outstanding.": when scheduling recovery of a charge.
- "That settlement did not deduct from this charge.": when reversing a deduction from a statement that never took it.

## Lease plans on settlements

Path: Operations › Drivers (/drivers) › driver › "Financial account" tab › "Edit" › "Lease charges" · Permission: accounting.view
Needs to change: accounting.edit

Lease plans take the lease charges on each weekly settlement for lease and owner drivers. Choose one of: "Lease owner" (rents the company tractor), "Leasing to owner" (leases toward owning it), "Owner truck" (own truck; only dispatch fee, insurance, IFTA and trailer rent).

Steps
1. Open the driver's "Financial account" tab and click "Edit".
2. In "Lease charges" pick the plan from the drop-down (default "No lease charges").
3. Choosing a plan for the first time sets contract type LO (OO for "Owner truck"), loaded pay 100% of gross, recurring deductions on, and escrow on with the $3,000 security deposit at $350 per settlement.
4. Adjust the charges:
   - "Tractor lease (weekly, by odometer)" with tiers: up to 200,000 mi $1,150; to 400,000 $1,050; to 650,000 $950; above $850 per week.
   - "Dispatch fee (% of gross, weekly)", default 20%.
   - "Maintenance fee (per mile driven in the week)": "Rate ($/mile)" $0.13, "Past the threshold ($/mile)" $0.20, "Threshold (odometer mi)" 130,000.
   - "Fixed charges": Trailer rent $220/wk, Office supplies $85/wk, IFTA $35/wk, Commercial insurance $500/wk, Occupational accident insurance $125/mo, Tablet / carrier fee $30/mo, Toll device fee $45/mo. Each can be ticked off or changed.
5. Fill "Reason for the change" and click "Save profile".

On the statement, lease lines appear under "Taken off (deductions)" with the miles and tier. Tractor lease and maintenance fee use the truck's Samsara odometer at the end of the week; a draft updates as readings arrive, and approval keeps the figures it was paid on.

Why it won't work
- "No odometer reading for <unit> by <date>: the tractor lease tier cannot be figured.": no ELD reading; the statement cannot be approved until there is one. Press "Enter odometer" under the warning to type it in (see "Enter the odometer from a statement").
- "No odometer readings for <unit> at both ends of the week: the maintenance fee cannot be figured.".
- The lease charges are missing: the plan is "No lease charges", or the profile was saved with an "Effective from" date after the week.
- The odometer messages also appear when the driver has no current truck: assign the truck, then "Update draft statements".

## Repair charges to drivers recovered from settlements

Path: Fleet › Repairs (repair / work order) and Operations › Drivers › driver › "Financial account" tab · Permission: accounting.view to see the driver account

When a repair (work order) is charged to the driver, it becomes a charge on the driver's financial account ("Shop charge - <WO number> …") and is taken from the next settlement. The rule: nothing comes off a driver's pay until the repair log records that the driver was told.

How it works
1. On the repair, Fleet sets who pays to the driver and records that the driver was informed.
2. When statements are created or updated, the charge is copied to the driver's account: "approved" if the driver was told, "pending" with reason "Held: the driver has not been told yet" if not.
3. An approved charge is recovered on the next statement as far as pay allows; the rest stays owed for later weeks.
4. If the repair is voided or changed to company paid, the charge becomes void ("The work order is no longer charged to the driver"). A charge already taken on an approved statement is not changed; a correction needs an adjustment.

Reversing a deduction: when a deduction taken on a statement is reversed, the driver's balance comes back by exactly that amount and a refund line ("Refund of deduction · …") is paid on the next statement.

Why it won't work
- The charge is not deducted: the driver was not told (pending). Statements also show "<n> transaction(s) this week still pending approval." Record that the driver was informed on the repair.
- The amount is wrong on an approved statement: approved statements never change; post an adjustment with "Manual charge".
- "$… is already recovered; the charge cannot go below it.": a claim charge can't be reduced below what was already taken.

## Pay week: Monday 12:00 noon to Monday 12:00 noon (US Eastern)

Path: Accounting › Settlements (/accounting/settlements) · Permission: accounting.view
Setting: Accounting › Accounting › "Settings" tab › "Settlements" box (needs accounting.overview to open, accounting.edit to change)

A driver pay week runs from Monday 12:00 noon to the next Monday 12:00 noon, US Eastern time (since 2026-10-21). A load is paid in the week in which it was completed (delivered, closed or TONU), by its delivered time, or by the status-update time if "Cutoff reads" says so. The boundary belongs to the new week: a load delivered Monday at 11:59 AM ET is paid in the week that is ending; one delivered at 12:00 PM ET or later is paid in the new week.

Where you see it
- The Settlements week picker and every statement show the real window, for example "Mon Oct 12, 12:00 PM – Mon Oct 19, 12:00 PM ET", with the "Payday" under it.
- The line under the tabs: "A load counts in this week if it was completed from … up to … (Monday noon to Monday noon, US Eastern)."
- The statement side panel shows "Pay week <window>" under "To pay out".

The setting
1. Open Accounting › Accounting › "Settings" tab.
2. In the "Settlements" box the field "Pay week starts and ends (Monday, US Eastern)" holds the time (12:00 = noon). Its note: "A load completed before this time on Monday is paid in the week that is ending; at this time or later, in the new week."
3. Tick "I confirm the settlement cutoff clock is US Eastern (America/New_York)" and click "Save settings". The settings summary shows "Pay week: Monday 12:00 to Monday 12:00, US Eastern".

To pay one load in a different week, change its pay date on the load (see "Change which week a load is paid in (Counts for pay on)").

Why it won't work
- "The cutoff clock (America/New_York) has not been confirmed in Settings › Accounting. Batches wait until it is.": tick the confirmation and save.
- A load delivered Monday morning is in last week's statement: correct, the week ends at Monday noon ET.

## Change which week a load is paid in (Counts for pay on)

Path: Operations › Loads (/loads) › load › "Financial" tab › "Driver pay" panel · Permission: accounting.view (to see the panel)
Needs to change: accounting.edit

The "Driver pay" panel ("Which pay week this load is paid in. For settlements only; the delivery stays as recorded.") shows "Counts for pay on" (the time, Eastern, with "Delivered time", "Status change time" or "Set by Accounting"), the "Pay week" and the "Delivered" time, and which statements the load is on ("On ST-…" or "Taken off ST-…"). It appears only on a delivered, closed or TONU load.

Steps
1. Open the load and go to the "Financial" tab.
2. In "Driver pay" click "Change pay date".
3. Fill "Counts for pay on (date, ET)" and "Time (ET)" ("Before Monday 12:00 noon is the week that is ending.").
4. Fill "Why (required, kept on record)", at least 3 characters (e.g. "Facility closed Sunday; driver was there on time").
5. Click "Save pay date". Toast "Pay date saved" with "Paid in <week>".
6. To undo, click "Change pay date" again, give a reason and click "Use the delivered time".

What happens after: the load moves to that week's draft statement and off every other week's draft, so it is paid in exactly one week. The panel shows "Changed by <name> on <date>: <reason>". The delivery time itself is not changed, and the change is audited on the load and on each statement.

Why it won't work
- "Change pay date" greyed and the panel says "On ST-…, which is approved. Reopen that statement to change the pay date.": the load is on an approved statement. Reopen it first (see "Reopen an approved statement to edit it").
- "On ST-…, which is paid. A correction goes on next week's statement.": a paid statement never changes.
- "<load> is on ST-… for <driver>, which is approved. Reopen that statement first, then change the pay date." / "… which is paid. Its pay date cannot change; a correction goes on next week's statement.".
- "ST-… for <driver> (<week>) is approved. Reopen it first, then move <load> into that week.": the target week's statement is already approved.
- "<load> is <status>; the pay date is set once the load is completed.": the load is not delivered yet. The panel is hidden until then.
- No "Change pay date" button: you lack accounting.edit. No panel at all: you lack accounting.view.

## Take a load off a statement and put it back

Path: Accounting › Settlements (/accounting/settlements) › statement row (side panel) · Permission: accounting.view
Needs to change: accounting.edit

While a statement is a draft, a load can be taken off this week (for example, POD not received). It is never lost: it goes on the driver's next statement automatically unless it is put back, and it is never paid twice.

Steps: take off
1. Open the statement (click its row in step 3).
2. Under "Earned", click "Take off" on the load.
3. Fill "Why <load> comes off this week" (at least 3 characters, e.g. "POD not received yet") and click "Take off this statement".
4. Toast "<load> taken off": "It goes on the driver's next statement. Put back returns it here." (or "It is on ST-… now.").

The load is then listed under "Not on this statement" with "Taken off by <name> · <date> · <reason>. Goes on the next statement unless put back." The full statement page lists it too.

Steps: put back
1. In the statement side panel, under "Not on this statement", click "Put back" on the load.
2. Toast "Put back on this statement". If the load had gone on next week's draft, it leaves that draft.

Why it won't work
- No "Take off" / "Put back" buttons: the statement is approved or paid, or you lack accounting.edit.
- "Say why the load comes off this statement (at least 3 characters).".
- "ST-… is approved; reopen it before a load comes off." / "… reopen it before a load is put back.".
- "<load> is already on ST-… (approved). Reopen that statement first, then put it back here.": a load is paid once.
- "That load is not on this statement." / "That load was not taken off this statement.": the page was out of date; reopen the statement.

## Reopen an approved statement to edit it

Path: Accounting › Settlements (/accounting/settlements) › statement side panel, or the full statement page (/accounting/settlements/<id>) · Permission: accounting.view
Needs to change: accounting.edit

An approved statement ("Approved") is frozen, but it can be reopened until its payment is recorded. Once "Record payment" is done it is "Paid · locked" for good, and any correction goes on next week's statement.

Steps
1. Open the approved statement (side panel or full page).
2. Click "Reopen to edit".
3. In "Reopen ST-…?" fill "Why (kept on record)" (at least 3 characters, e.g. "Fuel from Tuesday was missing") and click "Reopen".
4. Toast "Reopened": "ST-… is a draft again. The ledger entry was reversed; approve it again when it is right."
5. Make the changes (take off a load, add a deduction, skip a charge…), then approve it again.

What reopening does: the ledger entry is reversed (a mirror entry; nothing is deleted), the deductions the approval took are given back to the driver's account, and the recurring, lease, escrow and carried-forward lines it wrote are cancelled with the reason. Approving again posts a new entry. Audited as a reopen.

Why it won't work
- No "Reopen to edit" button: the statement is a draft or paid, or you lack accounting.edit.
- "ST-… is already paid; a correction goes on next week's statement.".
- "ST-… is in <KIND> <date>, which is closed; a correction goes on next week's statement.": the week was closed.
- "ST-… is on payment batch … ; take it off the batch first, or if the money has gone, record the payment and put the correction on next week's statement.".
- "ST-… is a draft under review; only an approved statement is reopened.".

## Skip, edit or delete a lease charge or recurring deduction

Path: Accounting › Settlements (/accounting/settlements) › statement side panel › "Taken off (deductions)"; also Operations › Drivers › driver › "Financial account" tab · Permission: accounting.view
Needs to change: accounting.edit (Delete: administrators only)

On a draft statement, each lease charge (tractor lease, maintenance fee, dispatch fee, fixed charges) and each recurring deduction under "Taken off (deductions)" has buttons. Escrow, fuel, tolls, advances and repayments have none: they follow the driver's profile and account.

Steps: skip this week
1. Click "Skip this week" on the line.
2. In "Skip <charge> this week?" fill "Why (kept on record)" (at least 3 characters, e.g. "Truck in the shop all week") and click "Skip this week".
3. The line moves to "Skipped this week" ("<amount> not taken"). Only this week; next week it is taken as usual.

Steps: put back a skipped charge
1. Under "Skipped this week" click "Put back", then "Put back" in "Put back <charge>?". It is taken again this week.

Steps: edit the amount
1. Click "Edit" on the line.
2. For a recurring deduction choose "This week only" or "From now on (every later week)". A lease charge is changed for this week only (change the plan itself on the driver's profile).
3. Fill "Amount" and "Why (kept on record)", click "Save $…". "Back to plan" drops this week's change.

Steps: delete (stop) a recurring deduction (administrators)
1. Click the bin icon on the recurring line (or on the driver's "Financial account" tab, the bin next to the recurring deduction).
2. "Delete <deduction>?": "It stops from this week on: no later statement takes it. Statements already approved keep what they took."
3. Fill "Why (kept on record)" and click "Delete". It is kept on record as cancelled.

Adding a deduction: on the statement press "Add deduction" (see "Review a statement and add a deduction or reimbursement"); on the driver's "Financial account" tab use "Manual charge" for a one-off charge or "Recurring deduction" for a weekly or monthly one. On the Financial account tab, an active recurring deduction also has "Edit" (from now on) and, for administrators, the bin icon.

Why it won't work
- No buttons: the statement is approved or paid (reopen it first), or you lack accounting.edit.
- No bin icon: only administrators can delete a recurring deduction ("Only an administrator can delete (stop) a recurring deduction.").
- "This driver's lease plan is the unsaved default. Save the financial profile once (Fix pay setup › Save profile), then change a week.".
- "Save" greyed: the reason is shorter than 3 characters or the amount did not change.

## Enter the odometer from a statement (no ELD readings)

Path: Accounting › Settlements (/accounting/settlements) › statement side panel ("Check before approving") or the full statement page · Permission: accounting.view
Needs to change: accounting.edit

A lease driver's tractor lease tier and maintenance fee follow the truck's odometer. When the ELD has no readings, the statement warns "No odometer readings for unit <unit> at both ends of the week: the maintenance fee cannot be figured." (or "No odometer reading for <unit> by <date>: the tractor lease tier cannot be figured.") and cannot be approved.

Steps
1. Open the draft statement. Under the warning click "Enter odometer".
2. In "Enter odometer · unit <unit>" fill "Start of week · <date>" (the reading on the day before the week began) and "End of week · <date>" (the last day of the week), in miles. One end is enough to start; both are needed for the maintenance fee.
3. Optional "Note (optional)" (where the figures came from, e.g. a photo of the dash).
4. Click "Save readings". Toast "Odometer entered". The statement recalculates: the maintenance fee (miles × rate) and the tractor lease tier appear and the warning goes away.

The figures are saved as manual readings on the truck at 23:59 Eastern of each day, under your name, so the PM / oil-change module sees them too.

Why it won't work
- No "Enter odometer" button: the statement is not a draft, has no truck, has no odometer warning, or you lack accounting.edit.
- "Saved, but not usable": a figure is below an earlier reading of the truck. It is kept as a conflict and not used; check the number.
- "Cannot be below the start." / "Enter the odometer at the start of the week, at its end, or both.".
- "ST-… is approved; it is locked and its odometer cannot change.": reopen it first.

## Fuel purchases on driver statements

Path: Fleet › Fuel (/fleet/fuel) → Accounting › Settlements (/accounting/settlements) · Permission: accounting.view

Fuel purchases recorded in Fleet › Fuel (Relay's sync or fills keyed in by hand) are brought onto the driver's account automatically when the week's statements are created or updated. Each purchase made in the pay week, for the driver (or for their truck when it names no driver), becomes one fuel line, for example "Fuel · Pilot #123 · Dallas, TX · 112.4 gal" (DEF purchases read "DEF · …").

Rules
- It is deducted only when the driver's profile has "Deduct fuel" on (default on for lease and owner operators, off for company drivers). Otherwise it is shown as the company's cost, never owed.
- Each purchase is brought in once: updating drafts never adds it twice. A purchase already imported from a Relay CSV is left to that import.
- If the purchase changes in the Fuel ledger (amount, place) before it is taken, the line follows; if it is no longer the driver's purchase, the line is voided.
- A purchase marked as a problem in the ledger waits for approval instead of being taken.

Steps
1. Make sure the purchases are in Fleet › Fuel for the week.
2. On Accounting › Settlements click "Create statements" or "Update draft statements".
3. Open a statement: the fuel lines are under "Taken off (deductions)" marked "Fuel".

Why it won't work
- Fuel is not deducted: "Deduct fuel" is off on the driver's "Financial account" profile, or the purchase is pending approval.
- A purchase is missing: it was outside the pay week (Monday noon to Monday noon ET) or is on another driver or truck in the Fuel ledger.

## Staff Payroll page

Path: Accounting › Payroll (/accounting/payroll) · Permission: payroll.view
Needs to change: accounting.edit

Staff Payroll pays office staff: dispatchers on four-week commission cycles and other departments on a fixed salary. Drivers are never paid here; they are paid through Settlements.

Tabs: "Dispatchers (4-week)", "Fixed Salary", "Pay Plans", "History". Cards: "Staff", "Ready", "Needs setup", "Approved payable".

Steps
1. Dispatchers: pick a date in "Select 4-week period". If there is no cycle start, click "Set cycle start", enter "Cycle start (Monday)" and "Confirm cycle start". Fixed Salary: set "Period" start and end.
2. Give anyone with "No plan" or "Formula missing" a plan: "Edit plan" › "Effective date", "Pay type" (Fixed salary / Dispatcher commission (4-week)), "Fixed salary per period" or commission fields, "Currency", "Frequency", "Why this plan" (required) › "Save plan".
3. Click "Calculate preview" (or "Create period"). Toast "<period> previewed".
4. Optional: "Adjust" a line (bonus, commission override with "Why is this being set by hand?", advance, adjustment) › "Save changes".
5. Click "Review", then "Approve for payroll". Tick the acknowledgement for each person left out, then "Approve n lines · $…". Approval posts the expense; it does not pay.
6. After paying, click "Create payroll payment". "Export" downloads the period as CSV.

The dispatcher commission comes from Dispatch › Commission (Weekly Board truck-weeks).

Why it won't work
- "Calculate preview" greyed with "Set the cycle start first", or "The four-week period anchor (a Monday) is not configured (Settings › Accounting).".
- "A salary period needs its start and end.".
- "Say why this pay plan is being set; it is kept with the version.".
- "Approve for payroll" greyed with "A line with a plan still needs its figure", or "<n> line(s) still need their figure: …".
- "<n> staff member(s) have no pay plan and would be left out of this period: … Acknowledge each exclusion, or set their plan first.".
- "Create payroll payment" greyed with "Approve the period first; approval does not pay"; "<period> is <status>; finalize it first.".
- "Say why this commission is being set by hand rather than computed.".
- "Only Accounting can change payroll.": needs accounting.edit.
