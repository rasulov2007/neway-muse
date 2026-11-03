# Accounting: RTS factoring (RTS batches)

RTS Financial is the factoring company: it buys the company's issued invoices and pays (funds) them early. In NeWay TMS, issued invoices are gathered into an RTS batch on the "RTS batches" tab of the Billing & Invoices page. NeWay then uploads the batch to RTS over FTPS ("Send to RTS"), or you download the files and upload them yourself and record the submission. RTS sends nothing back, so NeWay records what was sent and when. When RTS pays, the funding is recorded under Accounts Receivable.

## RTS batches tab: what it is and batch statuses

Path: Accounting › Invoices (/accounting/invoices) › RTS batches tab · Permission: accounting.view
Needs to change: accounting.edit (create, send, export, record, cancel, test packets)

An RTS batch is a package of issued invoices for RTS. Each invoice goes with its rate confirmation (RC), bill of lading (BOL) and proof of delivery (POD). It is not the same as "Create invoice", which turns a delivered load into a bill in the Billing queue, or a settlement batch, which pays drivers.

Steps:
1. Open Accounting › "Invoices" and choose the "RTS batches" tab.
2. The table lists every batch: "Batch" (RTS-00001, RTS-00002 …), "Created" (when and by whom), "Invoices", "Total", "Status", "Package" (exports made) and "RTS reference".
3. Press "Open" on a row to see the batch: its invoices, documents, buttons, "Sent to RTS" log, "Package exports" and "History".

Batch statuses:
- "Prepared": created. Nothing has been exported or sent.
- "Exported · not sent": a package or file set was downloaded. RTS has not been told anything.
- "Submitted (recorded)": sent to RTS over FTPS, or a person recorded that they uploaded it. Its invoices are marked submitted.
- "Cancelled": cancelled before submission. Its invoices can be batched again, and the batch and its history are kept.

Good to know:
- An invoice can sit in only one live batch (prepared, exported or submitted) at a time.
- Each invoice in a batch shows "Added to RTS-000NN" in its own history.
- If you see "Creating batches needs the Accounting edit permission.", you have view-only access.

## Set up the RTS FTPS account (Settings › Integrations)

Path: Administration › Integrations (/admin/integrations) · Permission: integrations.view
Needs to change: integrations.manage

"Send to RTS" and "Send RTS test packets" upload through the company's RTS account, "RTS Financial (FTPS)".

Steps:
1. Open Administration › "Integrations" and find "RTS Financial (FTPS)".
2. Press "Add account". Give an "Account name" and fill:
   - "Client number (FTP username)": the username RTS gave you. It is also the Client column of the CSV.
   - "Password".
   - "Server": ftps.financial.rtspro.com (FTPS, port 21), or the test server RTS gives you (ftps.rtsfinancial.com).
   - "Environment": type test or production. A test account uploads to the RTS test folder and marks nothing submitted.
3. Press "Add account" to store it. Secrets are encrypted and never shown again.
4. Press "Test" on the account. It logs in and lists the folder. The account must pass "Test" (show as connected) before Accounting can send.

Good to know:
- RTS has nothing to sync, so there is no "Sync" button for it.
- A login refused by RTS puts the account in error. Use "Replace credential" with the right password, then "Test" again.

Why it won't work (messages shown when sending from RTS batches):
- "RTS is not set up: add the RTS FTPS account in Settings › Integrations.": no RTS account exists.
- "RTS is not ready: the RTS account has not passed "Test" in Settings › Integrations.": press "Test" until it connects.
- "<account>: set Environment to test or production in Settings › Integrations.": the Environment field is blank or wrong.
- "<account> has no client number stored." / "<account> has no password stored.": replace the credential with both filled.
- "The stored RTS password cannot be read: it was sealed under a different server secret. Replace the credential."

## Create an RTS batch

Path: Accounting › Invoices (/accounting/invoices) › RTS batches tab · Permission: accounting.view
Needs to change: accounting.edit

Steps:
1. On the "RTS batches" tab press "Create RTS batch".
2. The dialog lists every current invoice. Eligible invoices come first and have a checkbox. Tick the ones to send.
3. Leave "Show invoices that cannot be selected, and why (N)" ticked to see the blocked invoices with their reason. Untick it to hide them.
4. Check the summary: "Invoices selected", "Total amount", and "Required documents" ("RC and POD on every invoice" or "N missing"). The "Documents" column shows RC, BOL and POD badges. A TONU invoice shows RC and TONU.
5. Read any "Worth checking before export" warnings, such as "No BOL in the package; RTS may ask for one." or a note that the invoice is a revision of one RTS already has.
6. Press "Create RTS batch (N)".

What happens after:
- Toast: "RTS-000NN created — N invoice(s), $X. Nothing has been sent; export the package next." The batch opens in "Prepared".
- Each invoice is reserved for that batch and cannot go into another until the batch is cancelled.
- For a revision RTS already has, only the increase is listed as new money ("Amount To Fund").

Why it won't work:
- The button stays grey: no invoice is ticked.
- An invoice has no checkbox: see "Why an invoice cannot go into an RTS batch".
- "Batch not created" with "<INV>: <reasons>": the invoice changed after the list loaded. Close and reopen the dialog.
- "Another batch already holds <INV>.": someone batched it at the same moment. Your batch was cancelled automatically. Reopen the dialog.
- "Only Accounting can prepare, export or record RTS batches.": you need accounting.edit.

## Issue invoices and send them to RTS from the Billing queue (several at once)

Path: Accounting › Invoices (/accounting/invoices) › Billing queue tab · Permission: accounting.view
Needs to change: accounting.edit

From the Billing queue you can tick many loads and move all of them on in one press: create the invoices, issue them, and send them to RTS in one batch. A load that is refused is listed with its reason, and the rest go on.

Steps
1. On the "Billing queue" tab tick the loads (checkbox "Select <load>"). Ready-to-bill loads, loads with a draft invoice and loads with an issued invoice can be ticked.
2. A bar floats at the bottom of the screen: "N loads selected · $total". It shows only the buttons that fit what is ticked:
   - "Create invoice (N)": for ticked loads with no invoice yet. Drafts are made; nothing is posted.
   - "Issue (N)": issues the ticked draft invoices one after another. Toast "N invoices issued" ("Select them and press Send to RTS when ready."); any refusal is listed as "<INV>: <reason>".
   - "Send to RTS (N)": for ticked issued invoices.
   - "Issue & send to RTS (N)": issues the ticked drafts first, then sends them with the issued ones.
3. For the two RTS buttons a window asks "Send N invoices to RTS?": "One RTS batch is made and every PDF (invoice with NOA, RC, BOL, POD) and the CSV are uploaded. Total $…". Press "Send to RTS".
4. Toast "RTS-000NN sent to RTS" ("N invoices with RC, BOL and POD."). With the test folder on it reads "(test folder)" and "A test upload marks nothing submitted."

What happens after: one batch is created (status "Submitted (recorded)" once the upload works) and its invoices are marked submitted. If the upload fails, the batch stays "Prepared" and the toast says "RTS-000NN prepared, not sent" with the reason and "Open the RTS batches tab to send it or download the files."

Why it won't work
- A button is missing: none of the ticked loads is in that state (for example, "Send to RTS" needs issued invoices).
- "Not sent to RTS" with "Nothing issued to send.": every draft was refused when issuing; read the reasons.
- The send fails: see "Why Send to RTS fails" (FTPS account, missing documents).
- Every load refused with "Only Accounting can …": the buttons show, but the server needs accounting.edit.

## Why an invoice cannot go into an RTS batch

Path: Accounting › Invoices (/accounting/invoices) › RTS batches tab › Create RTS batch · Permission: accounting.view

In the "Create RTS batch" dialog, an invoice that cannot be selected is greyed out. The reason is shown under its number. Exact reasons and what to do:

- "Still a draft: issue it first.": a draft with no other reason can be ticked (and Select all takes it); it is issued when the batch is created, after a confirmation. Otherwise issue the invoice (Invoices tab › "Issue invoice").
- "Voided.": a void invoice is never sent.
- "Already <status>: only an issued invoice that has not gone to RTS can be batched.": the invoice is already submitted, accepted, paid, partially paid, funded or disputed. Only an invoice in the plain "issued" status can be batched.
- "Superseded by a revision: batch the current revision instead.": batch the newest version (INV2-…, INV3-…).
- "Billed directly to the broker, not through RTS.": this invoice is not factored.
- "Nothing to fund: the total is zero."
- "Marked by a simulated test event; it cannot be sent for real."
- "RTS rejected it: correct it with a revision, then batch the revision.": create a revision on the invoice page, issue it, and batch the revision.
- "RTS submission already recorded (<status>).": it has already gone to RTS.
- "Already in RTS-000NN (<status>). Cancel that batch first if it has to be redone.": open that batch and press "Cancel batch" if it was not submitted.
- "No rate confirmation in the invoice's document package." / "No POD in the invoice's document package.": the RC or POD was not on file when the invoice was drafted. The package is frozen at drafting, so issue a revision after the file is on the load, or ask Accounting how to re-bill.
- "The rate confirmation it was issued with has since been replaced or rejected: revise the invoice." (same for "The POD …"): the file on the invoice is no longer the current one. Create and issue a revision, then batch it.
- "The rate confirmation file is not in the file store." / "The POD file is not in the file store.": the document record has no file. Re-upload the file on the load.

Warnings (they do not block):
- "No BOL in the package; RTS may ask for one."
- "Revision of <INV>, which RTS already has (<status>…). Only $X is new; RTS has not confirmed how it takes revisions."

## Send a batch to RTS (FTPS upload)

Path: Accounting › Invoices (/accounting/invoices) › RTS batches tab › Open batch · Permission: accounting.view
Needs to change: accounting.edit

"Send to RTS" uploads the batch straight to RTS's FTPS folder.

What is sent:
- One PDF per invoice, named exactly "<invoice number>.pdf". It holds the invoice sheet with RTS's Notice of Assignment (NOA) stamp at the bottom right, then the RC, BOL, POD and any supporting files of the charges. Every page is fitted to 8 x 10 inches portrait and sent in grayscale when the server can.
- Then one CSV with the columns Client, Invoice#, DebtorNo, Debtor Name, Load #, InvDate (MM/DD/YYYY) and InvAmt. The debtor name is repeated as DebtorNo. Load # is the broker's reference, or our load number when there is none. The amount is the invoice total, or only the increase for a revision RTS already has.
- RTS takes the submission the moment the CSV lands. The CSV always goes last.

Steps:
1. Open the batch ("Open" on its row).
2. Press "Send to RTS". The confirmation says how many invoices and the total, and that "RTS takes one submission every 5 minutes."
3. Press "Send to RTS" in the confirmation.

What happens after:
- Production account: toast "Sent to RTS — Every PDF, then the CSV, is on the RTS server. The invoices are recorded as submitted." The batch becomes "Submitted (recorded)". Each invoice's status becomes submitted, with the CSV name as its RTS reference. The upload is listed under "Sent to RTS".
- Test account: toast "Sent to the RTS test folder — A test upload: nothing is marked submitted." The batch and invoices stay as they were. The log line ends "TEST folder, nothing marked submitted".
- RTS sends no answer. Watch for RTS's funding and record it under Accounts Receivable ("Record RTS funding").

Why it won't work: see "Why Send to RTS fails".

## Why Send to RTS fails

Path: Accounting › Invoices (/accounting/invoices) › RTS batches tab › Open batch › Send to RTS · Permission: accounting.view
Needs to change: accounting.edit

A red toast "Not sent to RTS" shows the reason. Nothing is uploaded when a check fails before sending.

- "RTS takes one submission every 5 minutes. Send this one in N minute(s).": RTS refuses back-to-back submissions. Wait the minutes shown and press again. The gap counts from the last batch upload by your company.
- "Another RTS submission is uploading right now. Wait for it to finish.": only one upload runs at a time per company.
- "RTS-000NN is already submitted to RTS.": it has already gone.
- "RTS-000NN is cancelled.": a cancelled batch cannot be sent. Create a new batch.
- "RTS-000NN changed since you opened it. Reload and try again.": close the batch and reopen it.
- "RTS is not set up…", "RTS is not ready: the RTS account has not passed "Test"…", "<account>: set Environment to test or production…": fix the RTS account in Administration › Integrations.
- "Not sent - RTS would refuse it: …" followed by details:
  - "Nothing to send."
  - "RTS takes at most 999 invoices at a time; this has N."
  - "<INV>: <column> is blank." (for example Load # or InvDate): fill the missing data on the invoice or load.
  - "<INV>: the amount must be more than $0."
  - "<INV>: the invoice number has a character a file name cannot carry."
  - "<INV>: listed twice."
  - "<INV>: the <invoice/RC/BOL/POD> could not be read into the PDF.": the file is damaged or not a PDF or image. Replace it on the load, revise if needed, and rebuild the batch.
- "RTS upload stopped at <file>: <error>. N file(s) reached RTS; the CSV was not sent, so RTS has not taken this submission.": a network or login failure part-way through. Without the CSV RTS takes nothing. Fix the connection and press "Send to RTS" again after 5 minutes. If the message says the CSV was sent, RTS has taken it. Do not send again; record it with "Record manual submission" if needed.

## Download RTS files or export the review package

Path: Accounting › Invoices (/accounting/invoices) › RTS batches tab › Open batch · Permission: accounting.view
Needs to change: accounting.edit

Two downloads exist. Neither sends anything to RTS or marks any invoice as sent.

"Download RTS files":
- A ZIP named "RTS-000NN_RTS_FTP_files.zip" with exactly what "Send to RTS" would upload: one "<invoice#>.pdf" per invoice (NOA stamp, RC, BOL, POD, 8 x 10, grayscale) and the RTS CSV.
- If RTS would refuse something, a "PROBLEMS.txt" inside lists it.
- Use it to upload by hand in the RTS portal, or to send RTS the CSV after a test upload.

"Export review package":
- A ZIP named "RTS-000NN_RTS_package.zip" with a schedule of accounts ("schedule.csv"), and per invoice the invoice PDF, a cover page, the RC, BOL and POD files and one merged packet PDF, plus a "manifest.json".
- Use it for review or manual upload.

Steps:
1. Open the batch and press "Download RTS files" or "Export review package".
2. The browser saves the ZIP. The toast says "Nothing was sent" or "Nothing has been sent to RTS. Upload it there, then record the submission here."

What happens after: a "Prepared" batch becomes "Exported · not sent". Each download is logged under "Package exports" with time, person, file name, size and fingerprint. "Record manual submission" becomes available.

Why it won't work:
- "Package not exported" / "Files not prepared" with "RTS-000NN is cancelled.": a cancelled batch cannot be exported.
- "The package could not be prepared (<code>).": a server error or no permission (accounting.edit needed).

## Record a manual RTS submission

Path: Accounting › Invoices (/accounting/invoices) › RTS batches tab › Open batch · Permission: accounting.view
Needs to change: accounting.edit

Use this only after you uploaded the package to RTS yourself (in the RTS portal or by hand). "Send to RTS" records the submission automatically.

Steps (whole batch):
1. Open the batch. Export it first with "Download RTS files" or "Export review package".
2. Press "Record manual submission".
3. Fill at least one of: "RTS reference" (the schedule or batch number RTS gave the upload), "What you saw" (when RTS gave no reference), or "Evidence file" ("Attach" a screenshot or confirmation, image or PDF).
4. Set "Submitted on" and press "Record submission".

Steps (one invoice, from the Billing queue):
1. Open the load of an issued invoice that has not been submitted on the "Billing queue" tab.
2. In the invoice box press "Record manual submission…", give an "RTS reference" or "What you saw", and press "Record".

What happens after: toast "RTS-000NN recorded as submitted — N invoice(s) marked submitted with your evidence." The batch becomes "Submitted (recorded)". Each invoice's status becomes submitted and it leaves the list of invoices that can be batched.

Why it won't work:
- The button is grey with "Export the package first", and the note "Record manual submission becomes available once the package has been exported.": download a package first.
- "Record submission" is grey, and the dialog says "A submission needs a reference, a note or a file.": fill one of them.
- "Export RTS-000NN's package before recording that it was submitted."
- "RTS-000NN is already recorded as submitted." / "RTS-000NN is cancelled."
- "RTS-000NN changed since you opened it. Reload and try again."
- Per invoice: "Issue the invoice first." or "Say how you know the invoice was submitted: the provider's reference, or a note of what you saw. Mark it simulated if this is a test."

## Cancel an RTS batch

Path: Accounting › Invoices (/accounting/invoices) › RTS batches tab › Open batch · Permission: accounting.view
Needs to change: accounting.edit

Cancel a batch that has not been submitted when it was built wrong, or when one of its invoices must be revised. Cancelling releases its invoices so they can be batched again. The batch and its history are kept.

Steps:
1. Open the batch and press "Cancel batch".
2. Type the "Reason" (at least 3 characters) and press "Cancel batch". "Keep batch" closes the dialog without changes.

What happens after: toast "RTS-000NN cancelled — Its invoices can be batched again." The status becomes "Cancelled", and each invoice's history notes the cancellation. An invoice in a prepared or exported batch cannot be revised until the batch is cancelled.

Why it won't work:
- "RTS-000NN is recorded as submitted to RTS. A submitted batch is corrected with RTS, not cancelled here.": contact RTS. For a wrong invoice, issue a revision and send the revision in a new batch.
- "RTS-000NN is already cancelled."
- "RTS-000NN changed since you opened it. Reload and try again."
- The "Cancel batch" button is grey: type a reason.

## Send RTS test packets

Path: Accounting › Invoices (/accounting/invoices) › RTS batches tab · Permission: accounting.view
Needs to change: accounting.edit

RTS asks for a test submission before it gives production access. This sends three made-up invoices to the RTS test folder without touching real records.

Steps:
1. Make sure the company's RTS account in Administration › Integrations has "Environment" set to test and has passed "Test".
2. On the "RTS batches" tab press "Send RTS test packets".
3. Read the confirmation "Send three test packets to RTS?" and press "Send test packets".

What is sent: TEST-0001, TEST-0002 and TEST-0003 (test debtors, $1,200, $2,150 and $2,700). Each is an invoice with the NOA stamp plus RC, BOL and POD pages marked TEST, 8 x 10, grayscale, followed by their CSV. No load, invoice, ledger entry or batch is created. The upload is audited.

What happens after: toast "Test packets sent to RTS" listing the files and host. The CSV (TEST_<timestamp>.csv) downloads to your computer so you can send it to RTS.

Why it won't work:
- "Test packets go to an RTS test account only. This company’s RTS account is production.": the button never sends test data to production.
- "RTS takes one submission every 5 minutes. Try again in N minute(s).": the gap also counts real batch uploads.
- "RTS is not set up…" / "RTS is not ready…" / "set Environment to test or production…": fix the account in Integrations.
- "Another RTS submission is uploading right now. Wait for it to finish."
- "RTS upload stopped at <file>: …": a connection or login failure. Check the account with "Test".

## After RTS: funding, fees and factoring settings

Path: Accounting › Accounts Receivable (/accounting/receivables) › RTS funding tab · Permission: accounting.view
Settings path: Accounting › Accounting (/accounting) › Settings tab › Factoring (RTS) · Permission: accounting.overview
Needs to change: accounting.edit

RTS sends nothing back through the FTPS folder. When RTS pays, record the money in NeWay so the invoices close.

Steps (funding):
1. Open Accounting › "Accounts Receivable" and choose the "RTS funding" tab. The tile "Awaiting RTS funding" shows submitted invoices not yet funded.
2. Press "Record RTS funding".
3. Fill "RTS reference" (the schedule or funding number on RTS's notice) and "Funded on". Tick each invoice funded and enter "Funded now", then "RTS fee ($)" and "Reserve held ($)" if any, and "Notes".
4. Press "Record funding".

What happens after: the cash, the factoring fee and any reserve are posted, and the invoices' receivable is closed for the gross amount. A fully funded invoice shows "funded".

Factoring settings (Accounting › Accounting › "Settings" tab, box "Factoring (RTS)"):
- "Fee, basis points of gross" (75 = 0.75%), "Reserve / holdback, basis points" (0 when RTS keeps no reserve), and "Default payment terms (days)" for new invoices.
- Press "Save settings". A setting not yet confirmed is listed under "N settings need configuration".

Why it won't work:
- "Record RTS funding" is missing: no invoice is awaiting funding, or you lack accounting.edit.
- The settings fields are disabled: you need accounting.edit.
