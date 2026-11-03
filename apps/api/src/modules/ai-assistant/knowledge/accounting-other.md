# Accounting: overview, receivables, payables, expenses and reimbursements

The Accounting menu holds the company's books. This file covers the Accounting overview page, Accounts Receivable (what customers and RTS owe), Accounts Payable (what vendors are owed), Expenses, Reimbursements (money a driver paid out of pocket) and where driver charges are approved. Invoices, RTS batches, Settlements and Payroll are described elsewhere. Every figure comes from the ledger on the server; "today" is the company clock (US Eastern).

## Who can see and change accounting pages (permissions)

Path: Accounting (menu group) · Permission: accounting.view, accounting.edit, accounting.overview, accounting.bank

Accounting access is split into four permissions. There is no "accounting.manage" permission; the permission that allows changes is accounting.edit.

- accounting.view: opens Invoices, Accounts Receivable, Accounts Payable, Expenses, Reimbursements and Settlements, and reads everything on them.
- accounting.edit: needed for every change: recording a customer payment or RTS funding, adding, approving, scheduling and paying bills, adding and importing expenses, adding and reviewing reimbursements, approving driver charges, and saving Accounting settings. Without it the buttons ("Add Bill", "Add Expense", "Import", "Add reimbursement", "Record RTS funding", "Review", "Save settings") are hidden.
- accounting.overview: opens the Accounting overview page (/accounting) with company totals, the general ledger and Settings. It is meant for the accounting manager and is not part of the standard Accounting role.
- accounting.bank: payee bank details and payment batches.

The standard "Accounting" role has accounting.view, accounting.edit and accounting.bank, but not accounting.overview.

Steps to get access:
1. Ask an administrator to give your account a role that includes the permission you need.
2. Sign out and back in if the menu item still does not appear.

What happens: a page you have no permission for is not listed in the sidebar. Typing its address sends you to the first page you are allowed to open.

Why it won't work
- "Missing permission: accounting.edit": you can read the page but not change it. Ask an administrator for accounting.edit.
- The "Accounting" item is missing from the menu while Invoices and the other pages are there: you have accounting.view but not accounting.overview. Ask for accounting.overview if you are the accounting manager.
- "Only Accounting can record or review reimbursements.": the reimbursement action needs accounting.edit.
- "You do not have access to reimbursements.": you lack accounting.view.

## Accounting overview page (company totals, ledger and periods)

Path: Accounting › Accounting (/accounting) · Permission: accounting.overview

The financial command centre: revenue, expenses, profit, receivables, payables and cash for a chosen period, all read from posted journal entries.

Steps
1. Open Accounting › Accounting.
2. Pick the period with the period selector: "Today", "Week", "Month", "Quarter" or "Year" (Month is the default).
3. Use the tabs:
   - "Overview": a "Needs attention" list (for example invoices past due, invoices more than 90 days past due, bills past their due date, bills waiting for approval, bills due this week, settlements awaiting approval, journal entries that do not balance); click an item to open the matching list. "Reimbursements awaiting review" appears when drivers have pending items ("Review them"). Number cards "Revenue", "Expenses", "Gross profit", "Operating profit" (posted amounts only; unbilled loads and draft bills are excluded). Panels "Receivables" (outstanding, split Not due / 1 – 30 / 31 – 60 / 61 – 90 / 90+ days overdue, link "View receivables"), "Payables" (Due today, Due next 7 days, Overdue, Pending approval, Scheduled, link "View payables"), "Cash activity" (Received, Paid, Net cash movement), "Expense breakdown" ("Open expenses") and "Ledger summary" (total debits, credits, difference).
   - "Profit and loss": revenue, direct costs, gross profit and margin, operating expenses, operating profit, and a comparison with the previous period.
   - "Cost per mile": total cost, miles, cost per mile, direct cost per mile, revenue per mile, and cost by account.
   - "General ledger": the chart of accounts with balances (click an account to filter) and the journal of entries.
   - "Periods": each ledger month and whether it is open, closing or closed.
   - "Settings": see the section on Accounting settings.
4. "Export" › "General ledger (CSV)" downloads the ledger; "Print this page" prints.

Why it won't work
- Cost per mile shows "Cost per mile needs the miles the fleet turned in this period": no delivered-load miles exist in the period. Pick a longer period or wait for delivered loads.
- "Nothing has been posted to a cost account in this period": no expenses or bills are posted in the period.
- Ledger summary says "The ledger does not balance: a defect, not a data problem.": report it to the system administrator; it is not something to fix by hand.
- A posting is refused with "<month> is closed. Raise an adjustment in an open period instead of posting into a closed one.": the month is closed. Date the record in an open month or ask the accounting manager to post an adjustment.

## Accounting settings and the completed-load pipeline

Path: Accounting › Accounting (/accounting) › Settings tab · Permission: accounting.overview
Needs to change: accounting.edit

The Settings tab holds the business values accounting depends on and shows which providers are really connected. Above them, the "Completed-load pipeline" lists every completed load with its billing candidate and each driver's pay candidate.

Steps (settings)
1. Open Accounting › Accounting and click the "Settings" tab.
2. Read the alert: "N settings need configuration" lists each unset value and what it blocks; "Every accounting setting is confirmed" means nothing is missing.
3. The table "Business values and who confirmed them" shows the current value of each setting and who confirmed it.
4. Edit the fields: Factoring (RTS): "Fee, basis points of gross" (75 = 0.75%), "Reserve / holdback, basis points", "Default payment terms (days)", "QuickBooks owns postings?", Holiday fees. Settlements: "Cutoff time (Monday, company zone)", "Cutoff reads", the cutoff clock confirmation checkbox, "Payday", "LO/OO paid only after funding?", "Team base-mileage split", "Vendor default share, basis points", "Escrow target ($)", "Escrow per settlement ($)". Staff payroll: "Dispatcher four-week period anchor (a Monday)", "Payroll currency".
5. Click "Save settings". A toast "Settings saved" confirms.

The "Providers" panel shows each integration (RTS, Relay, BestPass, EFS, Breakthrough Fuel, QuickBooks, ADP, Email) as Live, Sandbox, Export only, CSV import only or Not configured.

Steps (pipeline)
1. The figures show Completed loads, Operational gross, Driver pay candidates and Errors.
2. Each row shows the load, its billing queue, the drivers, gross, pay ("Cannot calculate" if a pay plan is missing) and state (Processed, a blocker, or an error). "Retry" reprocesses one load.
3. "Backfill · dry run" shows what is missing without writing; "Apply backfill" then writes it. "Legacy escrow · dry run" and "Import once" bring in old escrow movements.

Why it won't work
- Fields are greyed out and there is no "Save settings" button: you lack accounting.edit.
- "Not saved" with a version message: someone else saved settings first. Reload the page and enter your change again.
- "Settings could not be loaded": a server problem; retry later.
- "Dry run failed", "Backfill failed", "Retry failed": the message under the toast names the reason; fix the load or pay plan it names and try again.

## Accounts Receivable: open invoices, aging and overdue

Path: Accounting › Accounts Receivable (/accounting/receivables) · Permission: accounting.view

Shows issued invoices that still owe money, how late they are, RTS funding and customer receipts. Unbilled loads are not receivables; nothing is owed until an invoice is issued.

Steps
1. Open Accounting › Accounts Receivable (page title "Receivables").
2. If loads are not invoiced yet, a banner "N unbilled loads · $X" appears; "Open billing queue" goes to Invoices.
3. Number cards: "Outstanding invoices", "Overdue" (past invoice due date), "Awaiting RTS funding" (submitted, not funded), "Unapplied receipts" (payments not yet allocated). Click a card to filter.
4. Tabs: "Open invoices", "RTS funding", "Receipts & allocations", "History" (paid and voided invoices).
5. On "Open invoices" filter by "Customer" and "Due status" (Not due, Overdue, 1–30, 31–60, 61–90, 90+ days) or search by invoice, customer or load. Choosing an overdue band shows the "Overdue by age" breakdown with the oldest invoice.
6. Columns: Invoice / Load, Customer, Due date (with "N days overdue"), Invoice amount, Open balance, RTS status, Action. Double-click a row or use "Open invoice" to see the invoice.
7. "Record receipt" on a row opens the payment dialog (see "Record a customer payment").

Collections and short pays: there is no separate collections or short-pay screen. Work the Overdue card oldest first. A payment smaller than the balance leaves the rest open and the invoice becomes partially paid. Disputes are recorded on the invoice page.

RTS funding is tracked on its own tab and is never added to outstanding invoices.

Why it won't work
- "No issued invoices to track": no invoice has been issued yet. Issue invoices from Accounting › Invoices.
- "Record receipt" is missing on a row: the invoice has no open balance or is still a draft.
- "Missing permission: accounting.edit" after "Apply payment": you can view but not record payments.

## Record a customer payment (receipt) against invoices

Path: Accounting › Accounts Receivable (/accounting/receivables) › Open invoices › Record receipt · Permission: accounting.view
Needs to change: accounting.edit

Records money received from a customer or broker and applies it across that party's open invoices.

Steps
1. Open Accounting › Accounts Receivable, find an invoice of the payer and click "Record receipt".
2. In "Record payment from <customer>" fill "Amount received", "Method" (ACH, Check, Wire, Card, Factoring, Cash), "Reference" (e.g. the ACH or check number) and "Received on". All four are required.
3. "Allocate oldest debt first" is ticked by default: the amount is spread over the most overdue invoices first. Untick it to type the amount for each invoice in the "Apply" column.
4. The footer shows "Applying $X of $Y" and either "Fully applied" or "$Z unapplied" (unapplied money is held until allocated).
5. Optional "Notes". Click "Apply payment".

After: the toast says "$X recorded from <customer>". Each invoice's balance drops; a fully covered invoice becomes paid, otherwise partially paid. The receipt appears on "Receipts & allocations"; an unapplied remainder shows in "Unapplied receipts".

Why it won't work
- "Apply payment" stays disabled: the amount is zero, the Reference is empty, the allocation has errors, or nothing is allocated to any invoice.
- "This allocation cannot be applied" with "<invoice> has a balance of X; Y would overpay it": lower the amount on that invoice.
- "Applying X but only Y was received": the lines add up to more than the amount received.
- "The same invoice appears twice in this payment" or "An application line must be for a positive amount": correct the lines.
- "Invoice <id> is not open for payment": the invoice is paid, void or draft.
- "That payment (same reference, date and payer) is already recorded.": it was saved before; check "Receipts & allocations" instead of entering it again.
- "Nothing open to apply against": the payer has no outstanding invoices.
- A message ending "Raise an adjustment in an open period instead of posting into a closed one.": the "Received on" date is in a closed month.

## Record RTS funding (factoring)

Path: Accounting › Accounts Receivable (/accounting/receivables) › RTS funding tab · Permission: accounting.view
Needs to change: accounting.edit

Records the money RTS advanced against invoices that were submitted to them. One funding can cover several invoices. RTS's fee and reserve come off; the rest is what reached the bank. Funding is never counted as a customer receipt.

Steps
1. Open Accounting › Accounts Receivable and click the "RTS funding" tab (or the "Awaiting RTS funding" card).
2. The table lists invoices sent to RTS with RTS status, Reference, Invoice, Funded, Fee and Awaiting.
3. Click "Record RTS funding" (shown only when something is waiting).
4. Fill "RTS reference" (the schedule or funding number on RTS's notice) and "Funded on".
5. Tick the invoices this funding covers and check "Funded now ($)" for each (it starts at the amount awaiting).
6. Enter "RTS fee ($)" (required, as charged on this funding) and "Reserve held ($)" if any.
7. Check "Reaches the bank": gross minus fee minus reserve. Add notes if needed and click "Record funding".

After: each invoice's funded amount and balance update; the funding appears under "Receipts & allocations".

Why it won't work
- "Record funding" stays disabled: the reference or fee is empty, no invoice is ticked, or an amount is invalid.
- "Each ticked invoice needs an amount above zero.": enter an amount or untick the invoice.
- "Fee and reserve are more than the gross.": check the numbers on the RTS notice.
- "Invoice <id> is <status>; only an issued or submitted invoice can be funded.": the invoice is draft or void.
- "Invoice <id> has N cents open; M would overpay it.": the funded amount is more than the invoice's open balance.
- "Invoice <id> is allocated twice." or "is not on file.": reopen the dialog and try again.
- "That event has already been posted (...); posting it again would double the money.": this RTS reference was already recorded.
- "Nothing is waiting on RTS funding.": no invoice is submitted and unfunded; submit invoices to RTS from Invoices first.

## Accounts Payable: vendor bills and their statuses

Path: Accounting › Accounts Payable (/accounting/payables) · Permission: accounting.view

What the company owes vendors: repair shops, fuel, tolls, leases and other suppliers.

Steps
1. Open Accounting › Accounts Payable.
2. Number cards: "Outstanding" (approved balance not yet paid), "Due this week", "Overdue" (due date passed, balance open), "Pending approval" (not yet owed until approved). Click a card to filter.
3. Tabs: "Bills", "Needs billing (N)" (completed repair orders waiting to become bills), "Payment history" (money paid to vendors).
4. On "Bills" filter by "Status" (Outstanding, Pending approval, Approved (open), Scheduled, Overdue, Partly paid, Disputed, Paid), "Vendor", "Category", or search bills, vendors or RO numbers.
5. Columns: Bill #, Vendor, Source (a repair-order link for repair bills), Unit, Bill date, Due, Amount, Paid / Balance, Status, Approval ("Needed" or "by <name>").
6. Click a row to open the bill drawer: vendor invoice, linked repair order ("Open Fleet Repair"), unit, dates and terms, amount, paid, balance, payments, original receipt, source and approval.
7. "Export" downloads the bills shown as a CSV.

Bill statuses: Pending approval → Open (approved) → Scheduled → Partially paid → Paid. Disputed and Void also exist.

Bills come from: "Add Bill" (manual), the "Needs billing" tab (completed repair orders), and fleet expenses posted to Accounting when the company has not paid the vendor yet.

Why it won't work
- "No bills yet": nothing has been added; add one or create bills from repair orders.
- "Add Bill" is missing: you lack accounting.edit.
- A bill shows "Approval Needed": it is $2,500 or more (or its vendor is not on file) and must be approved before it can be paid.

## Add a vendor bill or create bills from repair orders

Path: Accounting › Accounts Payable (/accounting/payables) › Add Bill / Needs billing tab · Permission: accounting.view
Needs to change: accounting.edit

Steps (manual bill)
1. Click "Add Bill".
2. Fill "Vendor" (required, from vendors on file), "Vendor invoice #" (optional), "Bill date" (required), "Amount" (required, above zero), "Category" (Maintenance, Fuel, Tolls, Lease, Other) and "Notes".
3. Click "Create bill". The due date is the bill date plus the vendor's payment terms.

Steps (from completed repairs)
1. Open the "Needs billing" tab. Each completed repair order shows Vendor, Unit, Completed, Amount, "Amount from" (Vendor invoice or Estimate), Documents and Review.
2. Only rows marked "Eligible" can be ticked: a vendor is on the work order and the amount is the vendor invoice total above zero.
3. Tick the rows and click "Create bills (N)".
4. Already handled orders are listed under "N completed repair orders already handled".

After: a bill of $2,500 or more is created as Pending approval; a smaller one is created already approved (Open). Creating or approving a bill never marks it paid. A repair order can become only one bill: running it again never makes a second bill.

Duplicates: the duplicate guard is per source (one bill per repair order, one per fleet expense). A manual "Add Bill" does not check the vendor invoice number, so search the bills by vendor invoice # before adding one by hand.

Why it won't work
- "That vendor is not on file.": add the vendor first (Fleet › Vendors), then create the bill.
- "A bill must be for a positive amount.": enter an amount above zero.
- "Select eligible repair orders (vendor and vendor invoice total on record)": tick at least one Eligible row.
- Review reasons on a row: "No vendor on the work order" or "No invoice total on the work order" (fix the repair order in Fleet); "Amount is the work-order estimate, not a vendor invoice" (enter the vendor invoice total on the repair); "Zero-cost repair (warranty or in-house): nothing owed"; "Cost already posted as an expense by Fleet" (a bill would double it); "Bill AP-xxxxx exists (status)".
- Skipped after creating: "Already billed", "Cost already posted as an expense; a bill would double it", "Zero-cost repair: nothing owed", "Not a completed work order".

## Approve, schedule and pay a vendor bill

Path: Accounting › Accounts Payable (/accounting/payables) › Bills tab · Permission: accounting.view
Needs to change: accounting.edit

Steps
1. Open Accounting › Accounts Payable; click the "Pending approval" card to see bills waiting.
2. Approve: in the row menu choose "Approve", or open the bill and click "Review bill". The bill becomes Open and records who approved it.
3. Schedule (optional): row menu or drawer "Schedule payment". The bill becomes Scheduled.
4. Pay: row menu "Record payment" or drawer "Record Payment". In "Pay <bill #>" enter "Amount" (starts at the full balance; cannot exceed it), "Method" (ACH, Check, Wire, Card) and "Reference" (required, e.g. check number). Click "Record payment". The payment is dated today.

After: a full payment makes the bill Paid; a smaller one makes it Partially paid. The payment appears on "Payment history" and in the bill drawer.

Why it won't work
- "Record payment" is not offered: the bill is still Pending approval, or its balance is zero.
- "<bill #> has not been approved yet.": approve it first.
- "<bill #> has a balance of $X; paying $Y would overpay it.": lower the amount.
- "A payment must be for a positive amount.": enter an amount above zero.
- "A <status> bill cannot move straight to <status>.": that step is not allowed from the bill's current status (for example a paid bill cannot be scheduled).
- A message ending "Raise an adjustment in an open period instead of posting into a closed one.": today's month is closed in the ledger; ask the accounting manager.
- "That was refused": the description under it gives the reason.

## Expenses: company costs and recoverable charges

Path: Accounting › Expenses (/accounting/expenses) · Permission: accounting.view
Needs to change: accounting.edit

Lists posted costs (fuel, tolls, repairs, lumper, insurance, permits, lease, recruiting, other) and who finally bears each one.

Steps
1. Open Accounting › Expenses and pick the period ("Today", "Week", "Month", "Quarter", "Year").
2. Cards: "Posted expenses" (drafts not counted), "Company-borne", "Recoverable charges" (from drivers or vendors), "CPM".
3. Tabs: "Transactions", "Import review (N)", "Recurring" (drivers' recurring deductions, edited on the driver's Financial account), "Categories" (category to ledger account).
4. Filter by Category, Truck, Driver, Vendor, Source, "Cost responsibility" (Company, Driver recoverable, Vendor recoverable), Status (Posted, Draft, Void). Click a row for "Expense details": receipt, source, transaction ID, truck and driver, cost responsibility, approval status, amount, links "View bill" or "Driver charge on the account".
5. To add one: "Add Expense", fill "Date", "Category", "Description" (at least 2 characters), "Amount", "Cost responsibility", optional "Truck" and "Driver", the "Company paid" switch and "Notes", then "Record expense". It is posted at once.
6. "Export" downloads the rows shown.

Driver advances are tracked separately and never counted in expense totals ("View advances").

Correcting an expense: the expense details are read-only here. A fleet expense is voided from Fleet › Costs; Accounting voids leave the record with a reversing ledger entry, never delete it.

Why it won't work
- "Record expense" disabled: amount is zero or the description is shorter than 2 characters.
- "An expense must be for a positive amount.": enter an amount above zero.
- Void refusals: "A void needs a reason."; "<EX-#> is covered by a bill. Void or credit the bill in Payables instead."; "<EX-#> has a driver charge linked to it. Settle or void that charge first."; "<EX-#> is owed back to a driver as a reimbursement. Reject it in Reimbursements instead."; "<EX-#> has been split into shares. Remove the shares first."; "<EX-#> is in a closed month (...). Reopen the month in Accounting, or post an adjustment there."
- CPM "Not available": no delivered miles or no posted costs in the period.

## Import fuel, toll and card expenses from CSV (Relay, BestPass, EFS)

Path: Accounting › Expenses (/accounting/expenses) › Import · Permission: accounting.view
Needs to change: accounting.edit

Provider APIs are not connected; expenses come in from CSV files exported from the provider portal.

Steps
1. Click "Import", choose the provider ("Relay" fuel, "BestPass" tolls, "EFS" fuel and cards, "Other CSV"), then "Choose file".
2. The preview shows "New lines", "Matched", "Unmatched", "Already on file" and each line with unit/card, the driver on that date and the match. Nothing is written yet.
3. Click "Confirm import (N)". Lines already on file are skipped, never doubled.
4. Open "Import review". For "unmatched" lines choose "Unit" and "Driver" and click "Match", or "Ignore".
5. Matched lines wait in "N matched, not yet posted"; click "Post N to expenses".

After: each line becomes an expense. Whether a driver is charged follows the driver's financial profile (Deduct fuel, Deduct tolls, Approved advances). An EFS line marked as a driver charge ("Driver charge?") creates a pending driver charge that Accounting approves on the driver's Financial account.

Why it won't work
- "Nothing new in this file": every line is already on file; re-importing does nothing.
- Line problems: "Date could not be read", "Amount could not be read", "Unit <x> is not in the fleet", "No unit or card on the line", "No driver assigned to unit <x> on <date>": match the unit and driver by hand or ignore the line.
- Not posted: "Not matched to a unit and a driver" or "Already posted".
- "The file could not be read" / "Import failed": check that the file is a CSV with a header row.

## Add a reimbursement for a driver's out-of-pocket expense

Path: Accounting › Reimbursements (/accounting/reimbursements) · Permission: accounting.view
Needs to change: accounting.edit

A reimbursement is money a driver paid from their own pocket (lumper, scale, parking, repair supplies). It is reviewed, then rides on the driver's next statement and is paid when that statement is paid.

Steps
1. Open Accounting › Reimbursements and click "Add reimbursement".
2. Fill "Driver who paid" (on a team load, the one who actually paid), "Expense date", optional "Truck", optional "Load" (search by load number, broker reference or customer; the driver's own loads come first), "Category" (Lumper, Scale, Parking, Repair and supplies, Other), "Payment source" (Driver personal funds, Company card, EFS / company advance, Other verified source).
3. Enter "Receipt total" and "Of which the driver funded" (leave empty if the driver paid all of it), "Currency" and "Description".
4. "Attach receipt", or fill "Reason the receipt is missing" (recorded under your name).
5. Check "Owed to the driver" and click "Record $X".

After: "Reimbursement recorded · $X pending review". If the company paid all of it, it is "Recorded as a company expense" and never enters the review queue. The cost appears once in Expenses.

Why it won't work
- "The receipt total must be more than zero."
- "The driver cannot have funded more than the receipt total."
- "Name the driver who actually paid."
- "This was paid from the driver's own funds, so say how much of it they funded."
- "This was paid by the company, so none of it is reimbursable to the driver. Record a split instead if the driver funded part of it.": with Company card or EFS, type 0 in "Of which the driver funded", or change the payment source.
- "Attach the receipt, or record an authorised reason for it being missing."
- "<driver> is not a driver on load <#>. Choose the load they ran, or leave the load empty...": pick the right load or none.
- "That load is not on file in this company."
- "The receipt could not be uploaded": try the file again (images or PDF).

## Approve or reject a reimbursement

Path: Accounting › Reimbursements (/accounting/reimbursements) · Permission: accounting.view
Needs to change: accounting.edit

Steps
1. Open Accounting › Reimbursements (or "Review them" on the Accounting overview). Click the "Pending review" card.
2. Click "Review" on a row. The drawer shows the receipt (always on a light page), driver who paid, payment source, receipt total, company-funded part, truck, load, who submitted and when.
3. Type a "Reason" (required to reject; kept either way).
4. Click "Approve $X" or "Reject".

After: Approved items appear under "Approved, not on a statement" and are picked up by the driver's next draft statement ("On unpaid statements", status On a statement). They become "Paid" only when that statement is recorded paid. If the draft statement is regenerated or reversed, the item returns to Approved. Rejected items keep the reason for the driver.

Statuses: Pending review, Approved, On a statement, Paid, Rejected.

Why it won't work
- "Reject" disabled / "A rejection needs a reason the driver can read.": type a reason.
- "Nothing to approve" / "There is nothing to reimburse: the company funded all of this receipt."
- "This reimbursement is already on statement <#>. Take it off that statement before reviewing it again."
- "This reimbursement has already been approved/rejected/paid.": only pending items can be reviewed.
- No "Review" button, only "Open": the item is not pending, or you lack accounting.edit.

## Approve driver charges from repairs, claims and fuel imports

Path: Operations › Drivers (/drivers) › driver profile › Financial account tab › Transactions · Permission: drivers.view and accounting.view
Needs to change: accounting.edit

Driver charges (repair or fleet costs charged to a driver, fuel or toll deductions, advances, manual charges) are not approved on Accounts Payable or Expenses. They live on the driver's financial account; settlements take only approved charges. Claim deductibles are the exception: they are approved on the claim (see below).

Steps (charges on the driver's account)
1. Open Operations › Drivers, open the driver's profile, the "Financial account" tab, then "Transactions".
2. Filter the state to "pending".
3. Click "Approve" on a pending charge. Approved charges are taken on the next statement.
4. On an approved charge, "Dispute" asks for a reason and stops recovery; "Resume" sets a disputed or paused charge back to approved.

Where these come from: a fleet expense charged to a driver and posted to Accounting; an EFS import line flagged as a driver charge (pending); fuel and tolls when the driver's profile says to deduct them (approved automatically); manual charges ("Manual charge", "Send for approval").

Steps (claim deductibles)
1. Open Safety › Claims (/safety/claims) and the claim.
2. In "Suggested for accounting", a charge sent to Accounting shows "Approve" and "Reject". Approving needs accounting.edit (or claims.approve_exceptions).

Why it won't work
- "An applied charge cannot be voided; post an adjustment instead.": the charge was already taken on a statement.
- "That charge is already on file (...).": the same charge was recorded before.
- No "Approve" button: you lack accounting.edit, or the charge is not pending.
- "Approving a driver charge takes accounting.edit or claims.approve_exceptions": ask for the permission.
- "<charge #> is not waiting for Accounting": the claim charge has not been sent to Accounting, or was already decided.
- "The driver notice with evidence is not recorded" / "Attach the driver's signed authorization for this charge": the claim charge is missing its notice or signed authorization; Safety must add it.
