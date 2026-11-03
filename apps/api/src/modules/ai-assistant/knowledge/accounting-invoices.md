# Accounting: Billing and Invoices

The Billing & Invoices page is where a delivered load becomes an invoice. Delivered or closed loads wait in the Billing queue until their paperwork checks pass. Accounting then drafts the invoice, issues it (this posts revenue and a receivable), and sends it to RTS for factoring from the RTS batches tab. Issued invoices are never edited in place. A change is made by a revision, and a mistake is undone by a void.

## The Billing & Invoices page and its tabs

Path: Accounting › Invoices (/accounting/invoices) · Permission: accounting.view
Needs to change: accounting.edit (create, issue, void, revise, review documents, RTS batches)

The sidebar item is "Invoices". The page title is "Billing & Invoices". It has three tabs at the top:

- "Billing queue": the delivered and closed loads waiting to be billed, with their document checks. This tab opens by default.
- "Invoices": the invoice register (draft, issued, paid, void and so on). You can record payments and void invoices here.
- "RTS batches": issued invoices packaged and sent to RTS, the factoring company.

Steps:
1. Open "Invoices" in the Accounting menu.
2. Use "Billing queue" to bill delivered loads. Use "Invoices" to find an existing invoice. Use "RTS batches" to send issued invoices to RTS.
3. Double-click an invoice row on the "Invoices" tab, or choose "Open invoice" from its row menu, to open the invoice page (/accounting/invoices/<invoice>).

Good to know:
- A load enters the billing queue only once it is delivered or closed. A TONU (truck ordered, not used) load also enters, billed on its TONU fee.
- Every status in the queue is worked out from the load and its documents. Nobody types it.
- If the "Invoices" tab is empty, the message reads "No invoices issued yet". When loads are waiting it adds "Review completed loads in Billing queue: N waiting."

Why it won't work:
- The menu item is missing: your role lacks accounting.view. Ask an administrator.
- Buttons are missing or the drawer says "You can view these documents but not review them": you have view access only. Creating, issuing, voiding, revising and reviewing need accounting.edit.

## Billing queue: what the tiles, filters and columns mean

Path: Accounting › Invoices (/accounting/invoices) › Billing queue tab · Permission: accounting.view

The Billing queue lists every delivered or closed load that still needs billing work, newest delivery first. It refreshes every minute.

Tiles at the top:
- "Ready to bill": how many loads can be invoiced now, and their total. Click it to filter.
- "Needs review": loads in review plus loads missing documents. The hint shows "N missing documents".
- "Selected total": the gross of the loads you have ticked.

Filter pills: "All", "Ready", "Needs documents", "Reference review" and "Invoiced". "Invoiced" shows loads whose invoice is waiting to go to RTS, has RTS submission issues, or has a draft revision. Use "Search loads…" to search by load number, broker reference, customer or broker.

Columns:
- "Load", "Broker ref", "Customer".
- "RC file": "File present" or "Missing".
- "Reference match": "Match", "No RC", "Unread", "Mismatch", "Reused file" or "No load ref".
- "POD": "Reviewed", or the POD state ("missing", "rejected", "not reviewed"). A TONU shows "TONU · evidence".
- "Gross": the invoice total, or what the invoice would carry (linehaul plus accepted billable accessorials, or the TONU fee).
- "Billing status": the invoice number once invoiced, otherwise "Ready to bill", "Needs documents" or "Needs review". Hover "Needs review" to see the first reason.
- "Review": opens the side panel "Review load <number>".

Steps to work a load:
1. Click a row or its "Review" button.
2. In the panel, check "Documents", read "Still blocking the invoice", and fix each item where it says.
3. When the panel shows "All good · ready to bill", press "Create invoice".

Why it won't work:
- "Nothing here. A load enters the queue when it is delivered or closed.": the load is not delivered yet, or it was cancelled without a fee. Finish the load on the Loads page.
- "The billing queue could not be loaded": a server or network error. Reload the page.

## Create an invoice from a delivered load

Path: Accounting › Invoices (/accounting/invoices) › Billing queue tab · Permission: accounting.view
Needs to change: accounting.edit

An invoice is drafted from a load that is "Ready to bill". Nothing is posted to the books until you issue it.

Steps (one load):
1. Open the "Billing queue" tab and click the load (or its "Review" button).
2. In the "Review load <number>" panel, confirm there is no "Still blocking the invoice" list. The panel should show "All good · ready to bill".
3. Press "Create invoice" at the bottom of the panel.

Steps (several loads at once):
1. Tick the checkbox on each "Ready to bill" row. Rows that already have a draft or issued invoice have a checkbox too; other rows do not.
2. A bar floats at the bottom of the screen: "N loads selected · $total". Press "Create invoice (N)". Use "Clear selection" to start over.
3. The same bar can also issue the drafts and send them to RTS: see "Issue invoices and send them to RTS from the Billing queue (several at once)".

What happens after:
- A toast says "N invoices drafted": "Drafts are on the Invoices tab; issue them to post."
- The invoice gets the next automatic number in the series INV-10001, INV-10002 and so on. You do not type it.
- The bill-to is the load's broker when the load has one, otherwise the customer.
- The lines are the linehaul (the linehaul charge, or the load rate) plus every accepted billable accessorial. Draft or dropped accessorials are left out. A TONU load gets one line: the TONU fee.
- Payment terms come from the default payment terms in Accounting settings.
- The documents on file (not replaced, not rejected) are frozen as the invoice's document package.
- The load is now locked for everyone but Accounting.
- The load row shows the invoice number. The draft waits under "Billing status" until you issue it.

Why it won't work:
- "Create invoice" is greyed out with the tooltip "Complete the checks first": the load still has blockers. Read "Still blocking the invoice" in the panel.
- Greyed out with "Already invoiced": the load already has a current invoice. Use "View invoice".
- A warning toast "0 invoices drafted" followed by a reason: the server re-checked the load and skipped it. The reasons are "Not on file", "Already on INV-…", or the blocker messages themselves.
- "Could not create invoices": a server error or a missing accounting.edit permission.

## Why an invoice cannot be created (load not ready to bill)

Path: Accounting › Invoices (/accounting/invoices) › Billing queue tab › Review load panel · Permission: accounting.view
Needs to change: accounting.edit

An invoice can be created only for a load in "Ready to bill". The "Still blocking the invoice" list in the load's review panel shows every reason in plain words, and the same words come back in the toast when "Create invoice" skips a load. Documents are checked first. If any document problem exists, the load sits in "Needs documents". Otherwise review items put it in "Needs review" ("Reference review" pill).

Refusals from "Create invoice" itself:
- "Create invoice" greyed out, tooltip "Complete the checks first": blockers below remain.
- Greyed out, tooltip "Already invoiced", or toast reason "Already on INV-…": the load already has an invoice (even a voided one). Open it with "View invoice".
- Toast reason "Not on file": the load is no longer visible to the company. Reload.
- "Could not create invoices": you lack accounting.edit, or a server error.

Document blockers ("Needs documents"):
- "No rate confirmation on file.": no current RC. Upload it on the load ("Upload or replace on the load").
- "N of M proofs of delivery on file.": each delivery stop needs a POD (at least one). Upload the missing POD on the load.
- "RC rejected: <reason>. Upload a replacement." (also "BOL rejected…" and "POD rejected…"): someone rejected that file. Upload a new file on the load. The replacement starts fresh.
- "A TONU needs the broker’s TONU confirmation or a revised rate confirmation on file.": a TONU bills on the TONU confirmation, never on a BOL or POD. Upload the TONU confirmation, or the revised RC sent after the cancellation.
- "The TONU fee is not recorded.": enter the TONU fee on the load's cancellation.

Review blockers ("Needs review"):
- "This file is also filed on N other load(s). A multi-load RC needs a reviewed mapping.": the same RC file sits on another load. Accounting resolves it in the panel ("Resolve as Accounting"), or a correct RC is uploaded.
- "An open flag says this load needs a person first.": the load has an open flag. Close it on the load.
- "N drafted accessorial(s) to accept or drop.": detention or other accessorial charges are still drafts. Accept or drop them on the load.

Not billable at all (the load is not in the queue):
- "The load is not delivered yet."
- "Cancelled without a fee: nothing to bill."

Good to know:
- An uploaded RC, BOL or POD counts as soon as it is on file. A review is not required, because RTS checks the documents and the broker reference.
- The broker reference on the RC is not compared with the load. Only a reused RC file blocks.
- Once an invoice exists, the panel shows the invoice instead. "Draft invoice waiting to be issued." means you still need to press "Issue invoice".

## Billing queues after the invoice: ready to submit, submission issues, revisions

Path: Accounting › Invoices (/accounting/invoices) › Billing queue tab › "Invoiced" pill · Permission: accounting.view
Needs to change: accounting.edit

Every load in the billing queue sits in exactly one queue, worked out from the load and its invoice (nobody sets it). The six queues are "Needs documents", "Needs review", "Ready to bill", "Ready to submit", "Submission issues" and "Revisions". The first three have their own pills ("Needs documents", "Reference review", "Ready"). The last three are shown together under the "Invoiced" pill.

What each queue means:
- "Needs documents": RC, POD (or TONU evidence) missing, or a file rejected.
- "Needs review": a reused RC file, an open flag on the load, or drafted accessorials.
- "Ready to bill": paperwork passes and there is no invoice yet. A draft invoice also stays here with "Draft invoice waiting to be issued." until it is issued.
- "Ready to submit": the invoice is issued and has not yet been sent to RTS. Put it in an RTS batch (RTS batches tab) or record a manual submission.
- "Submission issues": RTS rejected the submission. Each issue RTS gave is listed as a blocker. Correct the invoice with a revision ("Revise on the invoice page"), then send the revision to RTS.
- "Revisions": a revision of the invoice is a draft waiting to be issued.

When the load leaves the queue: once the invoice is recorded as submitted to RTS, accepted, paid or voided, the load no longer appears in the billing queue. Follow it on the "Invoices" tab, on "RTS batches", or on Accounts Receivable.

Steps to work an invoiced load:
1. Click the "Invoiced" pill and click the load.
2. The invoice box in the panel shows "Bill to", "Issued", "Total", "Balance" and "RTS" (for example "not prepared", "prepared", "submitted · <reference>").
3. Use the buttons there: "Issue invoice" (draft), "Record manual submission…" (issued, not yet sent), "RTS accepted…" / "RTS rejected…" (after a submission), or "Revise on the invoice page".

Why it won't work:
- "Issue the invoice first.": a submission cannot be recorded on a draft or void invoice.
- "Say how you know the invoice was submitted: the provider's reference, or a note of what you saw. Mark it simulated if this is a test." (or "…was accepted…"): give RTS's reference or describe what you saw.

## Review or reject a load's RC, BOL and POD from billing

Path: Accounting › Invoices (/accounting/invoices) › Billing queue tab › Review load panel › Documents · Permission: accounting.view
Needs to change: accounting.edit

Accounting checks the rate confirmation, bill of lading and proof of delivery where it bills, without needing dispatch's load permissions.

Steps:
1. Open the "Billing queue" tab and click the load.
2. Under "Documents" each file has a row: "Rate confirmation", "Bill of lading", "Proof of delivery". For a TONU the rows are "Rate confirmation" and "TONU confirmation". A file not uploaded shows "Missing".
3. Click the file name or "Preview" to see it. "Open full document" opens the RC in a new tab.
4. If the file is wrong, press "Reject". Type what is wrong (for example unsigned, wrong load or unreadable), then press "Confirm reject".
5. To upload or replace a file, use "Upload or replace on the load". It opens the load's Documents tab.

What happens after:
- A rejected file shows "Rejected" with who, when and why. The load moves to "Needs documents" with "<RC/BOL/POD> rejected: <reason>. Upload a replacement."
- A replacement is reviewed on its own. Replaced files are listed as "earlier file(s) … replaced and no longer count".
- File states read "Uploaded", "Reviewed" or "Rejected". Uploaded is enough to bill.

Why it won't work:
- "Confirm reject" stays grey and the panel says "A rejection needs a reason; it is kept with the file.": type at least 3 characters.
- "You can view these documents but not review them": you need accounting.edit.
- "Not recorded" with a message: the load changed since you opened it, or the file can no longer be reviewed (for example it was replaced). The panel reloads. Try again.
- Reviewing a document never clears the reused-RC check. That is a separate condition.

## Resolve a rate confirmation exception

Path: Accounting › Invoices (/accounting/invoices) › Billing queue tab › Review load panel · Permission: accounting.view
Needs to change: accounting.edit

When the RC check is blocking (most often "Reused file", meaning the same RC file is on another load), only Accounting can clear it, with a reason that is kept on the load.

Steps:
1. Open the load from the "Billing queue" and look at "Rate confirmation (RC) reference" to see the file.
2. Under "Resolve as Accounting", type why it is acceptable, for example "One RC covers loads A and B, confirmed with broker".
3. Press "Resolve exception".

What happens after:
- The toast "Exception resolved" says "Recorded with your name and reason." The reference blocker disappears. Document checks stay their own.
- If the RC is later replaced, earlier resolutions are set aside and the checks run again.

Why it won't work:
- "Resolve exception" stays grey: the reason needs at least 3 characters.
- "Only Accounting can resolve a billing exception." or "Could not resolve": you lack accounting.edit.

## Issue an invoice

Path: Accounting › Invoices (/accounting/invoices) · Permission: accounting.view
Needs to change: accounting.edit

Issuing turns a draft into a real bill. It posts revenue and accounts receivable, sets the issue date and due date, and freezes the PDF exactly as issued.

Steps (any of these):
1. On the "Invoices" tab, open the row menu of a "Draft" invoice and choose "Issue invoice".
2. Or open the invoice page and press "Issue invoice" at the top.
3. Or in the "Billing queue", open the load and press "Issue invoice" in the invoice box of the panel.

What happens after:
- A toast reads "<INV-number> issued" ("Posted to accounts receivable and revenue.").
- Issued date = today (server clock). Due date = issued date + the invoice's payment terms (Net N days).
- The invoice is marked ready for RTS ("prepared") and shows in the "Invoiced" pill of the billing queue as ready to submit. It can now go into an RTS batch.
- The "Accounting" tab of the invoice shows the journal entry. The PDF is frozen, so later payments or revisions never change the document the broker received.

Why it won't work (short list; every message is explained under "Why an invoice cannot be issued"):
- A red toast "That was refused" or "Refused" with a reason: the paperwork checks failed again at issue time (missing or rejected RC/POD, reused RC, open flag, drafted accessorials), the accounting period is closed, or the total is $0. Fix what the message names and press "Issue invoice" again.
- "<INV-number> has already been issued.": someone else issued it. Reload.
- No "Issue invoice" button: the invoice is not a draft, or you lack accounting.edit.

## Why an invoice cannot be issued

Path: Accounting › Invoices (/accounting/invoices) · Permission: accounting.view
Needs to change: accounting.edit

The paperwork checks run again at the moment you press "Issue invoice". A draft can lose its ground after it was made: a POD replaced or rejected, an RC changed, a resolution set aside. When issuing is refused, a red toast "That was refused" (or "Refused") shows the reason.

Messages and what to do:
- "<INV-number> has already been issued.": someone else issued it. Reload the page.
- "No rate confirmation on file." / "N of M proofs of delivery on file." / "<RC/BOL/POD> rejected: <reason>. Upload a replacement.": the load's paperwork no longer passes. Fix the documents on the load, then issue again.
- "This file is also filed on N other load(s)…": the RC is reused. Resolve it in the billing queue panel ("Resolve exception").
- "An open flag says this load needs a person first.": close the load's open flag.
- "N drafted accessorial(s) to accept or drop.": accept or drop the drafted charges on the load.
- "The load is in <queue>; it cannot be invoiced yet.": the load is not in the ready state. Open it in the billing queue to see why.
- "The load is not delivered yet." or "Cancelled without a fee: nothing to bill.": the load's status changed. Correct the load first.
- "An invoice with no billable amount cannot be posted": the draft's total is $0. A draft's lines are copied from the load when it is created and cannot be edited, so correct the load's rate or charges and ask your administrator how to re-bill it.
- "<period> is closed. Raise an adjustment in an open period instead of posting into a closed one." (or "…is locked…"): today's accounting period is closed. Ask whoever manages the ledger periods.
- "That event has already been posted (…); posting it again would double the money.": it was already posted. Reload.

Good to know: the "Issue invoice" button appears only on a "Draft" invoice. Issuing needs accounting.edit.

## Find invoices: the Invoices tab, filters and statuses

Path: Accounting › Invoices (/accounting/invoices) › Invoices tab · Permission: accounting.view

The invoice register lists every invoice, 25 per page.

Steps:
1. Open the "Invoices" tab.
2. Click a summary tile to filter: "Total", "Draft", "Outstanding", "Partly paid", "Overdue", "Disputed", "Paid". Each shows a count and a balance.
3. Or use "Search invoice, customer, broker, load…", the "Status" filter (Draft, Issued, Sent, Outstanding, Partly paid, Overdue, Disputed, Paid, Void) and the "Bill to" filter.
4. A "Needs attention" panel may list exceptions. Click one to filter to the invoices concerned.
5. Click "Invoice #" or double-click a row to open it. The row menu offers "Open invoice", "Issue invoice" (drafts), "Record payment" (issued with a balance) and "Void" (nothing paid).

Columns: "Invoice #", "Bill to", "Load", "Issued" ("Not issued" for drafts), "Due" (red when late with a balance), "Amount", "Paid", "Balance", "Age", "Status".

What the words mean:
- "Age" counts from the due date, not the issue date. "In terms" means not yet due. "12d" means 12 days past due.
- Outstanding = issued with a balance (not draft, not void). Overdue = past the due date with a balance.
- Statuses: draft, issued, submitted (recorded as sent to RTS), accepted (RTS accepted), partially paid, paid, funded (paid through RTS funding), disputed, superseded (replaced by a revision), void.

Why it won't work:
- An invoice is missing: check the Status filter and the "Bill to" filter, and clear them with the filter bar's clear button.
- "Record payment" is not offered: the invoice is a draft, void or has no balance.
- "Void" is not offered: money has been applied to it. Reverse the payment first.

## The invoice page: overview, lines, payments, accounting, documents

Path: Accounting › Invoices (/accounting/invoices/<invoice>) · Permission: accounting.view
Needs to change: accounting.edit (issue, record payment, void, revise, notes)

Open any invoice from the "Invoices" tab (click its number) or from the billing queue panel ("View invoice"). The header shows the invoice number, bill-to and total, a status badge, "N days past due" or "In terms", and "Net N · balance $X".

Header buttons:
- "Issue invoice": only on a draft.
- "Record payment": on an issued invoice with a balance.
- "Void": when nothing has been paid.

Tabs:
- "Overview": the "Versions" table (every version with its own "Preview" and "PDF"), the revision controls ("Create revision"), the "Invoice note", "Internal notes", and panels "Invoice", "Bill to" (links to the broker or customer and to the load) and "Payment".
- "Line items": charge, description, qty, rate, amount and total.
- "Payments": payments applied to this invoice. Empty reads "Nothing received yet".
- "Accounting": the journal entries this invoice produced. A draft shows "Nothing posted yet".
- "Documents": the current RC, BOL, POD and other files of the load, each with "Open". It reads "No documents on the load yet" when there are none.
- "Activity": issued and payments received, newest first.

Why it won't work:
- "That invoice is not on file": the link is out of date or the invoice belongs to another company. Use "Back to invoices".
- Documents tab says "The load's documents need Loads access": the files belong to the load. Ask for the Loads view permission.
- "Create revision", "Edit" or "Add note" are missing: you need accounting.edit, or the invoice is still a draft. A draft cannot be revised; only its printed note can be edited.

## Revise an issued invoice (add detention, correct an amount)

Path: Accounting › Invoices (/accounting/invoices/<invoice>) › Overview › Versions · Permission: accounting.view
Needs to change: accounting.edit

An issued invoice is never edited. A revision creates a new version: INV-10452 becomes INV2-10452, then INV3-10452. It is drafted first, with nothing posted. Issuing it posts only the difference and makes it the current version. The earlier version keeps its PDF, payments and history.

Steps:
1. Open the invoice and stay on "Overview". Press "Create revision".
2. In "Create revision of <number>", type the "Reason for the revision". It is printed on the revised invoice.
3. Change the charges: edit type, description or amount, remove a line, press "Add approved <charge> ($)" to add an approved load accessorial not yet billed, or "Add charge" for a new line. Under "Supporting documents" you can tick the load files that back a charge (for example a detention approval).
4. Optionally change the "Invoice note".
5. Check "Original total", "Revised total" and "Difference", then press "Create draft revision".
6. A banner "<INV2-…> is a draft revision · nothing has been posted" appears. Press "Issue revision", check the summary ("Accounting posts", "Payments received", "After issuing"), then press "Issue revision" again.
7. To abandon the draft, press "Discard draft", type a reason and press "Discard".

What happens after:
- The new version is "Current". The old one becomes "superseded" and is kept as issued.
- Payments carry over. If they exceed the new total, the page shows "Credit of $X owed to <customer>". Nothing is refunded automatically.
- If RTS already had the earlier version, an alert "RTS already has <number>" warns that the revision must be submitted to RTS separately. Only the adjustment is new funding.

Why it won't work:
- "Create draft revision" is grey and the dialog says "Change a charge or the printed note to create a revision.": nothing changed. The reason also needs 3 or more characters.
- "Only the current issued invoice can be revised.": you opened an old, void or draft version.
- "<number> changed since you opened it. Reload and try again.": someone else changed it. Reload.
- "<number> is in RTS-000NN, which has not been submitted. Cancel that batch first, so RTS is never sent a version that has been replaced.": cancel the RTS batch, then revise.
- "<number> is being revised by someone else. Reload in a moment.": only one draft revision is allowed at a time.
- "A supporting document is not on this load.": choose a file from this load.
- "<number> is no longer the current version; this draft is out of date.": discard it and start again.
- "Only Accounting can revise invoices or change their notes.": you need accounting.edit.

## Layover or extra charge after the invoice was sent to RTS (supplemental invoice)

Path: Operations › Loads (/loads) › load › Financial tab › Charges after invoicing, or Accounting › Invoices (/accounting/invoices/<invoice>) › Overview · Permission: accounting.view
Needs to change: accounting.edit

Once RTS has an invoice (it is in a live RTS batch, submitted or funded) that invoice is never changed. A layover, detention, lumper or other charge that comes in later is billed on a **supplemental invoice** for the same load, numbered after the original: INV-10004-S1, then -S2.

1. Open the load › **Financial** tab › card **Charges after invoicing** › **Add charge after invoicing** (or open the invoice › Overview › **Add charge after invoicing**).
2. In "Add charge after invoicing · INV-…" fill **Charge** (Layover, Detention, Lumper…), **Description** and **Amount**; **Attach proof** (or "Or use a document already on the load").
3. If the driver earns part of it, tick **Pay the driver** and choose **Driver gets**: The full amount, A percentage (**Percent**) or A fixed amount (**Driver amount**).
4. **Add another charge** for more lines; write **Why it came after invoicing**; leave **Issue it now** ticked; press **Create supplemental invoice**. The toast says "INV-…-S1 issued … INV-… is unchanged."
5. Billing queue › **Invoiced**: the load is back with INV-…-S1. Tick it › **Send to RTS (1)** › **Send to RTS**. RTS gets its own row with the same load reference, and the packet carries the supplemental invoice, RC, BOL, POD and the proof.
6. When RTS pays, record it in Accounts Receivable › **RTS funding** › **Record RTS funding**; the supplement is its own line.

The driver: if the load's statement is still a draft, the share is added when it recomputes. If that statement was already approved or paid, the share is paid on the first open week's statement as a late accessorial, once.

A sent or funded invoice can no longer be revised ("Create revision" is replaced by **Add charge after invoicing**). Voiding a supplement removes its charges from the load; the original invoice stays as it was.

## Invoice note and internal notes

Path: Accounting › Invoices (/accounting/invoices/<invoice>) › Overview · Permission: accounting.view
Needs to change: accounting.edit

There are two kinds of note:
- "Invoice note" is printed on the invoice PDF and travels in the customer and RTS package ("Visible on invoice PDF and customer/RTS package").
- "Internal notes" are for Accounting only ("Internal only — not sent to customer or RTS"). They are never printed or sent.

Steps (invoice note on a draft):
1. Open the draft invoice. Under "Invoice note", press "Edit".
2. Type the note and press "Save note".

Steps (invoice note on an issued invoice):
1. The note is locked: "<number> has been issued: the printed note changes by a revision (a note-only revision posts nothing)."
2. Press "Create revision", change only the "Invoice note", give a reason, and press "Create draft revision". Then press "Issue revision". Nothing is posted.

Steps (internal note):
1. Under "Internal notes", type in the "For Accounting only" box and press "Add note".
2. To change one, press "Edit" beside it and then "Save". Earlier wording is kept under "Earlier wording".

Why it won't work:
- "<number> has been issued. The printed note changes by a revision, so the broker is never holding a version that says something else.": use a revision.
- "<number> changed since you opened it.": reload and try again.
- "That note is not on this invoice.": the note was removed or the page is stale. Reload.
- No "Edit" or "Add note" buttons: you need accounting.edit.

## Void an invoice

Path: Accounting › Invoices (/accounting/invoices) · Permission: accounting.view
Needs to change: accounting.edit

Voiding cancels an invoice without deleting it. For an issued invoice a reversing journal entry backs out the revenue and the receivable. Both entries stay on the books with the reason.

Steps:
1. On the "Invoices" tab open the row menu and choose "Void", or press "Void" on the invoice page.
2. In "Void <number>?", type the "Reason", for example "Billed to the wrong party; re-issuing to the broker."
3. Press "Void invoice".

What happens after:
- Toast: "<number> voided — A reversing entry was posted; the original stays on the books." A draft is simply marked void, with nothing to reverse.
- The balance becomes $0 and the status "Void".
- When no other live version of the invoice remains, the load's invoice link is cleared, so the load can be edited again.
- The voided invoice still counts as the load's invoice in the Billing queue. The load does not come back as "Ready to bill", and "Create invoice" for it answers "Already on <number>". If a voided load has to be billed again, ask your administrator.
- Voiding a draft revision is done with "Discard draft" instead.

Why it won't work:
- The "Void" option is missing, or "<number> has $X applied. Reverse the payment before voiding it.": money was applied. Reverse the payment first.
- "A void needs a reason.": type a reason. The server needs at least 3 characters.
- "<period> is closed. Raise an adjustment in an open period instead of posting into a closed one.": today's period is closed for posting.
- An invoice that is in an RTS batch, or already submitted to RTS, should first be corrected with RTS or its batch cancelled. The void itself does not check this.

## Download or preview the invoice PDF (and emailing)

Path: Accounting › Invoices (/accounting/invoices/<invoice>) › Overview › Versions · Permission: accounting.view

Steps:
1. Open the invoice. In the "Versions" table press "PDF" to download a version, or "Preview" to view it in a window.
2. From the billing queue, open the load's panel and click "PDF" beside "View invoice".

What you get:
- An issued invoice is served from the PDF frozen at the moment of issue ("As issued <date time>"). Later payments or revisions never change it.
- A draft is rendered fresh ("Draft preview; not issued").
- Each revision has its own PDF. The superseded version keeps the one it was issued with.
- The printed "Invoice note" appears on the PDF. Internal notes never do.

Emailing: there is no "email invoice" button on the invoice pages. Send the PDF yourself, or send invoices to the factoring company through the "RTS batches" tab.

Why it won't work:
- The download fails: your session expired or you lack accounting.view. Sign in again.

## Record a customer payment on an invoice

Path: Accounting › Invoices (/accounting/invoices) · Permission: accounting.view
Needs to change: accounting.edit

Use this for money a customer or broker paid you directly. Money from RTS is recorded as a funding on Accounts Receivable ("Record RTS funding").

Steps:
1. On the "Invoices" tab choose "Record payment" from the row menu, or press "Record payment" on the invoice page. It appears only on an issued invoice with a balance. On Accounting › Accounts Receivable (/accounting/receivables) the same dialog opens from "Record receipt" on an open invoice row.
2. In "Record payment from <party>", fill "Amount received", "Method", "Reference" and "Received on".
3. Allocate the money to open invoices, or use "Allocate oldest debt first". Add "Notes" if needed.
4. Press "Apply payment".

What happens after: the invoice shows the paid amount and balance and becomes "Partly paid" or "Paid". Any amount not applied is held as unapplied cash.

Why it won't work:
- "Apply payment" is grey: the amount is 0, the reference is empty, or the allocation is invalid.
- "<number> has a balance of X; Y would overpay it": lower the amount applied to that invoice.
- "Applying X but only Y was received": the allocations add up to more than the payment.
- "The same invoice appears twice in this payment", "An application line must be for a positive amount", "Invoice … is not open for payment": correct the allocation lines.
- "That payment (same reference, date and payer) is already recorded.": it is a duplicate.

## Invoice numbers, payment terms and the load lock

Path: Accounting › Invoices (/accounting/invoices) · Permission: accounting.view
Settings path: Accounting › Accounting (/accounting) › Settings tab · Permission: accounting.overview
Needs to change: accounting.edit

Invoice numbers:
- Numbers are automatic. A new invoice takes the next number after the company's highest: INV-10001, INV-10002 and so on. You cannot type or change it.
- Revisions keep the family number with the version in front: INV-10452, then INV2-10452, then INV3-10452.
- A voided invoice keeps its number. Numbers are never reused.

Payment terms and due date:
- Each new invoice takes the "Default payment terms (days)" from Accounting › Accounting › "Settings" tab, in the "Factoring (RTS)" box. Press "Save settings" after changing it.
- The due date is set when the invoice is issued: issue date + terms. The invoice page shows "Net N".

The load lock:
- When an invoice is drafted, the load's billed facts belong to Accounting. Other people's edits to the load are refused with "<load> is invoiced (<invoice id>). Ask Accounting for a correction; notes can still be added."
- To change the money after issue, use a revision. Voiding the invoice clears the lock once no live version remains.

Why it won't work:
- Settings fields are disabled: you need accounting.edit, and the Accounting overview page needs accounting.overview.

## Accounts Receivable and invoice aging (overdue buckets)

Path: Accounting › Accounts Receivable (/accounting/receivables) · Permission: accounting.view
Needs to change: accounting.edit (record receipts and RTS funding)

Accounts Receivable (page title "Receivables") shows issued invoices and what they still owe. Nothing is owed until an invoice is issued, so unbilled loads are only a banner, never a receivable.

Steps:
1. Open "Accounts Receivable" in the Accounting menu.
2. Read the four tiles: "Outstanding invoices" (open balance and count), "Overdue" ("Past invoice due date"), "Awaiting RTS funding" ("Submitted, not funded") and "Unapplied receipts" ("Payments awaiting allocation"). Click a tile to filter.
3. Use the tabs: "Open invoices", "RTS funding", "Receipts & allocations", "History" (paid and voided).
4. Filter with "Search invoice, customer or load", "Customer" and "Due status" ("Not due", "Overdue", "1–30 days", "31–60 days", "61–90 days", "90+ days").
5. Press "Record receipt" on a row to record a customer payment, or double-click to open the invoice.

How aging is counted:
- Age is counted from the invoice's due date (issue date + payment terms), on the server's clock (US Eastern), not from the issue date. An invoice inside its terms is "Not due" ("In terms" on the Invoices tab).
- Buckets: current (not past due), 1–30, 31–60, 61–90 and 90+ days past due.
- Clicking "Overdue" shows "Overdue: $X on N invoices", the oldest invoice ("Oldest: <number> · N days overdue") and a total per age band. Click a band to narrow the table.
- Only invoices with an open balance count. Drafts and voided invoices never count.
- RTS funding is tracked on its own tab and is not added to outstanding invoices.

The yellow banner "N unbilled loads · $X" ("Not included in receivables. Documents and references still need validation.") links to "Open billing queue".

Why it won't work:
- "No issued invoices to track": nothing is issued yet. Issue invoices from Accounting › Invoices; "Review unbilled loads" opens the billing queue.
- "Record receipt" is missing: the invoice has no balance or is a draft.
- "Record RTS funding" is missing on the "RTS funding" tab: nothing submitted is waiting for funding ("Nothing is waiting on RTS funding."), or you lack accounting.edit.
