# Drivers, customers and brokers

The Operations menu holds the people and companies freight runs through: Drivers (the roster, each driver's profile, documents, truck, pay, vacation and termination), Customers (who the freight comes from and what each relationship earns) and Brokers (broker records, payment terms, risk grade and the do-not-use flag). Figures on these pages (revenue, profit, margin, on-time) are computed from loads; a figure the system cannot compute shows "—" with the reason on hover, never $0.

## Find a driver on the Drivers page

Path: Operations › Drivers (/drivers) · Permission: drivers.view

The Drivers page lists every driver with whether they can take freight now and what their work has earned.

Steps
1. Open Operations › Drivers. Three tabs sit at the top: "On the roster" (working drivers), "Terminated" and "Archived".
2. The tiles are filters: "Total drivers", "Inactive drivers", "Driving", "Home", "Compliance hold", "Safety hold". Click a tile to show only those drivers; click it again to clear.
3. Type in "Search driver, driver # or unit" to search by name, driver number (D-2031) or truck unit.
4. Use the "Availability" dropdown or "Filters" for any availability: Available, Assigned, Driving, At pickup, At delivery, Home, Home time (scheduled), Compliance hold, Safety hold, Inactive. "Clear filters" removes it.
5. Columns: Driver, Availability, Current load (click to open the load), Unit, Compliance ("Clear" or "Held" — hover "Held" to see why), Loads, Revenue, Rev / total mi, Profit, Margin.
6. Click a row to open the driver's full profile page (/drivers/<driver id>).

Notes
- "Add driver" (top of the table) opens the new-driver form over the list.
- Hovering an Availability badge shows the reasons behind it.
- A "—" in a money column means the driver's loads could not be priced; hover it for the reason.

Why it won't work
- "Drivers could not be loaded" — the roster did not load. Click retry; if it repeats, reload the page.
- "No drivers match" — a tile, availability filter or search is hiding everyone. Click "Total drivers" or clear the search.
- A driver is missing from the list — they may be terminated (Terminated tab) or archived (Archived tab).

## Add a new driver

Path: Operations › Drivers (/drivers) › "Add driver" (also /drivers/new) · Permission: drivers.view
Needs to change: drivers.edit

Adds a driver to the roster and opens their qualification file in Safety. The new driver starts with status Onboarding, "Compliance hold", and cannot be assigned a load until Safety collects and verifies the documents.

Steps
1. On Operations › Drivers click "Add driver".
2. "Identity": "First name", "Last name" (required). Tick "Legal name differs from the above (as printed on the CDL)" only if the licence prints a different name. "Phone" (required; a US number formats itself as (555) 010-1431 while you type; a number starting with + is left as typed), optional "Secondary phone" with "Label" (Cell, Home, Spouse, Dispatch only), "Email" (required), "Preferred language" (English, Spanish, Russian, Uzbek).
3. "Documents": attach "CDL — front of the card" (required; JPG, PNG or PDF up to 20 MB). "CDL — back of the card" is optional. A photo is read automatically and fills empty fields; check them against the card. The DOT medical card and the driver photo are collected by Recruiting, not here.
4. "Licence": "State" (two letters), "CDL class" (Class A / Class B), "Endorsements" (H, N, T, X), "CDL expires" (required; shows how many days are left).
5. "CDL details": what was read from the card; nothing here is required.
6. "Employment": "Driver type" (Company driver, Owner-operator, Lease operator), "Hire date" (defaults to today), "Home city" and "State", optional "Truck" (only units with no driver that are not sold, inactive, out of service or in the shop are listed).
7. "Pay": "Pay plan" — Per mile, Percent of linehaul, Lease owner, Leasing to owner, Owner truck. For Per mile enter "Rate per mile" (default 0.60); for Percent of linehaul enter the percent. The three lease plans need no rate: the driver is paid the whole gross less the lease sheet's charges and the $3,000 deposit ($350 a week); choosing one switches Driver type to Lease operator (Owner truck: Owner-operator).
8. Click "Add driver".

What happens next
- A toast says "<name> added as D-####". The driver number is the next free number, continuing D-2001 upward; a number already reserved for a candidate in Recruiting is never reused.
- An employee record and an onboarding plan are opened for the driver.
- The CDL is filed "pending verification"; Safety verifies it. If the CDL file could not be filed, the toast says so: attach it again from Safety or the driver's Documents tab.
- The dispatcher is not chosen here: add it later on the driver's profile ("Add dispatcher").

## Why a new driver cannot be added

Path: Operations › Drivers (/drivers) › "Add driver" · Permission: drivers.view
Needs to change: drivers.edit

Why it won't work
- "Add driver" button is disabled, tooltip "Attach the CDL and the medical certificate first" — the CDL front is not attached yet. Only the CDL front is actually required; attach it.
- "Attach the CDL and the medical certificate before adding the driver." / "Attach the CDL before adding the driver." — same cause: attach the CDL front photo.
- "First name is required", "Last name is required", "Phone is required", "Home city is required" — fill the field.
- "Enter a phone number the driver can be reached on" — the phone has letters or is too short. "Enter a phone number, or leave it empty" — same for Secondary phone.
- "Enter a valid email address" — fix the email.
- "Use the two-letter state code" — CDL State or home State must be two letters, e.g. IL.
- "CDL expiry is required" / "CDL expiry is not a valid date" — pick the expiry date.
- "This CDL has already expired. Check the date." — the expiry is in the past; almost always a typo.
- "Hire date is required" — pick a hire date.
- "Enter the pay rate" — Per mile or Percent of linehaul needs a rate above 0.
- "A driver with the email <email> is already on the roster" — every driver needs a unique email in the company. Search the roster; the person may already exist (check the Archived and Terminated tabs).
- "Attach a JPG, a PNG or a PDF." / "That file is larger than 20 MB." — wrong file type or too big for the CDL drop zone.
- "Filed, but nothing could be read off it. Type the details below from the card." — not an error: type the licence details by hand.
- A refusal about permission — adding drivers needs drivers.edit; ask an administrator.

## Driver profile page: tabs and cards

Path: Operations › Drivers (/drivers) › click a driver (/drivers/<driver id>) · Permission: drivers.view

One driver on one page: who they are, whether they can run, their truck, pay and history.

Header
- Name, "Driver D-#### · <driver type>", and buttons "Open current load" (if on a load), "Open safety", and a "More actions" menu (vacation; see the vacation section).
- "Employment" shows the stored status (Onboarding, Available, Off duty, Vacation, Suspended, Terminated, Inactive…); "Dispatch" shows availability and the words "Can take a load now" or "Cannot take a load now".
- Fact strip: "Current truck", "Driver type", "Pay plan", "Hired".
- Panels "Under investigation with this driver" (repairs/expenses held under investigation) and claim driver charges appear when there are any.

Tabs
- "Profile": cards "Contact information", "Assignment and equipment", "CDL information" (each with "Edit"), "Accounting & payment details" (payee, masked bank details; set up in Accounting › Settlements), "Escrow and employment" (escrow balance, "Record escrow movement", "Terminate driver"), "Pay and organization" (pay plan, dispatcher with "Add dispatcher"/"Change", department, manager, "Open settlements", "Open employee record"), and "Availability" (the blocker and reasons).
- "Performance": Work, Money, Miles and service figures.
- "Documents": the qualification file — upload, replace and view documents.
- "Safety": safety reports and signed consents from the hiring record.
- "Onboarding": onboarding checklist and travel from the hiring record.
- "Costs": recruiting costs.
- "Loads": this driver's loads.
- "Financial account": earnings, debt, escrow, deductions, statements and the financial profile (pay plan, lease plan).

Why it won't work
- "No such driver" — "This driver is not in the roster. They may have been archived." Check Drivers › Archived.
- "This driver could not be loaded" — retry.
- Safety / Onboarding / Costs tabs say "This driver did not come through the recruiting journey, so there is no hiring record here." — normal for drivers added directly or imported. "The hiring record needs the recruiting permission." — ask for recruiting access.

## Edit a driver's contact, CDL or dispatcher

Path: Operations › Drivers › driver profile (/drivers/<driver id>) › Profile tab · Permission: drivers.view
Needs to change: drivers.edit

Steps (contact)
1. On the "Contact information" card click "Edit". The dialog "Edit contact information" opens.
2. Change "Phone", "Secondary phone", "Email", "Preferred language", "Home city", "State".
3. Click "Save changes". A toast says "<name> updated".

Steps (licence)
1. On the "CDL information" card click "Edit" ("Edit CDL information").
2. Change "CDL class", "State", "CDL expires", "Medical card expires", "Endorsements" (comma separated: H, N, T, X).
3. Click "Save changes".

Steps (dispatcher)
1. In "Pay and organization" (click the row to open it), find "Dispatcher".
2. Click "Add dispatcher" (nobody assigned) or "Change".
3. Pick the dispatcher and click "Save" ("Dispatcher saved"). Choosing none removes the dispatcher ("Dispatcher removed").

Notes
- Name, driver type and hire date are not editable on these cards.
- Changing a CDL date here does not verify anything; Safety verifies documents on the Documents tab / Driver Qualifications.

Why it won't work
- "A driver with the email <email> is already on the roster" — another driver uses that email.
- A message about permission — editing needs drivers.edit.
- "The driver could not be saved." — retry; reload if it repeats.
- "Not saved" on the dispatcher dialog — the server refused; the message says why.

## Assign, change or remove a driver's truck

Path: Operations › Drivers › driver profile (/drivers/<driver id>) › Profile tab › "Assignment and equipment" · Permission: drivers.view
Needs to change: drivers.edit, trucks.edit or truck_assignment.edit

A truck carries one driver. The pairing is saved on both the driver and the truck and recorded in the truck's assignment history.

Steps
1. On the "Assignment and equipment" card click "Assign" (no truck) or "Change" next to Truck, or the card's "Edit".
2. The dialog "Assign a truck" / "Change truck" opens. In "Truck" type a unit number. Sold and inactive units are not listed; each option shows the unit's status and current driver.
3. If the unit already has a driver, a warning says "<name> comes out of that unit" — assigning takes that driver out.
4. Click "Assign". To take the driver out of their truck, click "Unassign" (or clear the picker and click "Take out of the truck").
5. A toast confirms "<name> is in unit <unit>" or "<name> has no truck". The card then shows "Previously unit <unit>".

A truck can also be chosen when adding the driver ("Truck" on the Add driver form).

Why it won't work
- "Unit <unit> is archived. Restore it before assigning a driver." — restore the truck in Fleet first.
- "Unit <unit> is sold and cannot be assigned" / "... is inactive and cannot be assigned" — choose another unit.
- "<name> is terminated and cannot be put in a unit" — terminated or archived drivers cannot take a truck.
- "<name> is already in unit <unit>. Use Change to edit the assignment."
- "The driver on this unit was changed by somebody else meanwhile; reload and try again."
- "No truck <id>" — the unit no longer exists; reload.
- Button "Assign" disabled — the picked truck is the one the driver already has.

## Upload or replace a driver document

Path: Operations › Drivers › driver profile (/drivers/<driver id>) › Documents tab · Permission: drivers.view

The Documents tab is the driver's qualification file — the same records Safety and Driver Qualifications read, so a document attached here is attached everywhere.

Steps
1. Open the driver and the "Documents" tab. Rows are grouped "Driver documents", "Safety reports", "Other requirements", each with "Review status", "Expiry", "Waiver until".
2. Filter with "Search documents…", "All types", "All statuses".
3. On a row click "Upload" (nothing on file), "Replace" (a file exists) or "View". Or click "Add document" at the top.
4. In the dialog choose "Document type", drop the file (or "browse files"; photo types take images), optional "Title", "Issue date (optional)", "Expiry date" (required for types that expire; some types fill it from the issue date), "Notes (optional)".
5. Click "Add document" / "Replace document". The toast says "<title> attached — Received; Safety verifies it separately."
6. The row menu has "Details" (what is required and why) and "Open in Compliance".

What happens after: the document is "received", not verified; the driver stays on hold until Safety verifies it.

Why it won't work
- "Choose the document type" / "Choose the file first" — pick both.
- "<requirement> expires - enter the expiry date" — the type tracks expiry; enter the date. The button stays disabled until you do.
- "That file is larger than 20 MB." — use a smaller file.
- "Safety holds no compliance record for this driver, so nothing can be reported here." — the driver has no qualification file; contact Safety.

## Driver pay plan, lease plan and financial profile

Path: Operations › Drivers › driver profile (/drivers/<driver id>) › Financial account tab · Permission: drivers.view
Needs to change: accounting.edit

The pay plan chosen on Add driver is only the starting point. Settlements use the driver's financial profile, edited on the Financial account tab by Accounting.

Steps
1. Open the driver, tab "Financial account". Tiles: "Earned, not settled", "Outstanding debt", "Escrow balance", "Pending deductions", "Approved, unpaid".
2. If "No financial profile saved yet" shows, click "Set up profile"; otherwise click "Edit" beside "Expense responsibility".
3. In "Financial profile" set "Contract type" (Company driver, Lease operator, Owner operator), "Effective from", the deduction switches, "Loaded pay plan" (None, Per mile ($), % of linehaul, % of gross, Flat per load ($)) and "Loaded rate" (percent: 30 means 30%), "Empty pay plan" / "Empty rate" (blank means no empty-mile pay).
4. "Lease charges": pick a plan (No lease charges, Lease owner, Leasing to owner, Owner truck). Choosing one sets the contract to Lease operator (Owner truck: Owner operator), pay to 100% of gross, and escrow to the $3,000 deposit at $350 per settlement. Then set "Tractor lease (weekly, by odometer)" tiers, "Dispatch fee (% of gross, weekly)", "Maintenance fee (per mile driven in the week)" with threshold, and "Fixed charges".
5. Escrow: "Escrow target ($)", "Escrow per settlement ($)", "Escrow opening balance ($)", "Opening debt ($)" and the "reconciled" ticks. Optional "Reason for the change".
6. Click "Save profile". It is effective-dated: earlier statements keep their terms.

Also here: "Manual charge", "Recurring deduction", and "Pay rate needs confirmation" when a roster rate could be read two ways — pick "It is <x>%" or "It is <multiplier>".

Why it won't work
- No "Edit"/"Set up profile" buttons — you lack accounting.edit; Accounting changes the profile.
- "Not saved" — someone changed the profile meanwhile or a value is invalid; reload and repeat.
- "Unconfirmed" badge on Pay plan — the rate needs confirmation by Accounting before earnings can be finalised.

## Send a driver on vacation and record the return

Path: Operations › Drivers › driver profile (/drivers/<driver id>) › "More actions" (⋮) · Permission: drivers.view
Needs to change: drivers.edit or dispatch.manage

Steps (start)
1. Open the driver. The "More actions" menu appears only when the driver is Available or Off duty (or already on vacation).
2. Choose "Send on vacation". Set "Vacation start" (today or earlier), optional "Expected return" (a plan only, never ends the vacation) and "Reason / note".
3. Click "Confirm vacation". The status becomes Vacation and days away count from the start. Loads are not changed.

Steps (manage)
1. The banner "On vacation since <date>" shows days away; click "Manage vacation" (or "More actions" › "Manage vacation").
2. Tab "Edit vacation" — change dates or note, "Save changes".
3. Tab "Record actual return" — pick "Actual return", click "Record actual return". The driver becomes Available. This does not give Safety clearance.
4. Tab "Cancel vacation" — for a vacation entered by mistake; "Why it is cancelled" (3+ characters), click "Cancel vacation". It stays in the history marked cancelled.

After 30 or more days away, "Vacation-return drug test required before the next load" shows; Safety reviews it under Operations › Vacation returns ("Open Safety review →").

Why it won't work
- "A vacation starts today or earlier" / "Pick the start date" / "The expected return cannot be before the start".
- "The actual return cannot be in the future" / "... cannot be before the start".
- "<name> is already on vacation." / "This driver already has an open vacation."
- "A driver who is <status> cannot be sent on vacation; only available or off duty."
- "This overlaps the vacation from <date> ...; correct or cancel that one first."
- "This vacation was changed by someone else. Reload and try again."
- "The return was already recorded on <date>." / "This vacation was cancelled."
- No "More actions" button — you lack drivers.edit / dispatch.manage, or the driver is not Available/Off duty.

## Terminate a driver

Path: Operations › Drivers › driver profile (/drivers/<driver id>) › Profile tab › "Escrow and employment" · Permission: drivers.view
Needs to change: drivers.edit

Termination ends employment and settles escrow: charges for unreturned property, an accident deductible and other charges come out of escrow; what escrow cannot cover goes to the final settlement; what is left is owed back to the driver.

Steps
1. Open the driver, Profile tab, card "Escrow and employment". Click "Terminate driver".
2. "Why they are leaving": "Reason" (Resigned; Dismissed — performance; Dismissed — safety; Abandoned the truck; Failed a drug or alcohol test; Medical; End of contract; Other), "Last day", "Note", "Eligible for rehire".
3. "Company property": untick anything not returned (Tablet / ELD $450, Tire chains $380, Straps and binders $220, Fuel card $50, Toll transponder $35, Truck and trailer keys $120, Pallet jack $600, Safety kit and PPE $90).
4. "Accident and other charges": tick "There is an accident on this driver" and enter "Deductible charged" and "What happened"; optional "Other charge" and "What for".
5. Read "What this settles": Escrow held, Charges, Taken from escrow, Owed back to the driver, Not covered by escrow.
6. Click "Terminate driver".

What happens after: status becomes Terminated, the driver is taken out of their truck, an escrow offset is recorded on the driver account, and they move to Drivers › Terminated with reason, last day, rehire eligibility, property not returned and escrow.

Why it won't work
- "<name> is already terminated" — nothing to do.
- "That driver is not on the roster" — reload.
- "Changing a driver status needs drivers.edit." — ask an administrator.
- "No escrow has been recorded for this driver..." — not an error: every charge goes to the final settlement.

## Terminated and archived drivers; restore a driver

Path: Operations › Drivers (/drivers) › "Terminated" or "Archived" tab · Permission: drivers.view
Needs to change: drivers.edit (Restore)

- "Terminated" lists drivers whose employment was ended through "Terminate driver": Last day, Reason, Rehire eligibility, Property not returned, Accident, Escrow. Filter by "Any rehire eligibility" / "Eligible" / "Do not rehire".
- "Archived" lists drivers taken off the roster without a termination: hidden from the Drivers list, every picker and the dispatch boards, but kept. Columns: Driver, Status when archived, Unit, Archived, Reason. Search "Search driver, driver #, unit or reason".

Restore an archived driver
1. Open Drivers › "Archived".
2. Click "Restore" on the row (shown only with drivers.edit).
3. Toast: "<name> is back on the roster — And on the dispatch boards from this week."

Archiving a driver is not a button in the app; it is done by an administrator.

Why it won't work
- "<name> is not archived any more. Reload and try again." — someone already restored them.
- "<name> was archived again by someone else. Reload and try again."
- No "Restore" button — you lack drivers.edit.

## Driver statuses and why a driver cannot take a load

Path: Operations › Drivers (/drivers) and the driver profile · Permission: drivers.view

Each driver has a stored employment status and a computed dispatch availability.

Availability and its cause
- "Inactive" — status Terminated or Inactive.
- "Safety hold" — status Suspended: "Safety must lift the suspension before this driver can be assigned".
- "Compliance hold" — a qualification requirement is missing, expired or unverified: "Resolve <requirements> to release this driver". Fix it by uploading the documents (Documents tab) and having Safety verify them.
- "Compliance hold" for a new driver — "Driver is onboarding; their qualification file is still open" / "Finish onboarding and verify the required documents". Every driver added from Add driver starts in Onboarding.
- "At pickup", "At delivery", "Driving", "Assigned" — on a load.
- "Home" — Off duty or sleeper.
- "Home time (scheduled)" — on Vacation (the reason reads "Driver is on home time").
- "Available" — "Qualified, unassigned and on duty".

Where to look: the profile header says "Can take a load now" / "Cannot take a load now"; the "Availability" section on the Profile tab shows the blocker in red and every reason; on the list, hover the Availability badge or "Held".

## Customers page

Path: Operations › Customers (/customers) · Permission: customers.view
Needs to change: customers.edit (status), customers.archive (archive/restore)

Shows each customer relationship ranked by profit, computed from loads.

Steps
1. Open Operations › Customers. Search "Search customer, MC number, contact"; filter "Status" (Active, Inactive, On hold).
2. Columns: Customer, Status, Active loads, Total loads, Revenue, Total miles, Rev / total mi, Profit, Margin, On-time delivery, Avg dwell, Detention. Customers whose profit cannot be computed sort last.
3. Click a row to open the drawer: tabs "Overview" (Primary contact, Address, Payment terms, Credit limit, MC number, USDOT), "Loads", "Financial" (Profitability, How they pay: invoices, avg days to pay, paid on time, outstanding, overdue, disputed), "Performance" (How they run). Buttons "View profitability" and "All loads".
4. The row menu (…) offers "Edit" (opens the drawer), "Create load" (opens Add load, needs loads.create), "Put on hold", "Make inactive", "Make active", "Archive", "Restore".

Notes
- There is no "Add customer" button on this page, and the drawer is read-only.

Why it won't work
- "Customers could not be loaded" — retry.
- "Archive is blocked" — "<name> has N active loads. Reassign or complete the loads first."
- "The status could not be changed" — the message underneath says why (for example "Already active").
- Missing menu items — you lack customers.edit / customers.archive.

## Brokers page and broker risk

Path: Operations › Brokers (/brokers) · Permission: brokers.view
Needs to change: brokers.edit (status), brokers.archive (archive/restore)

Steps
1. Open Operations › Brokers. Chips: "All brokers", "Active", "On hold", "Do not use".
2. Search "Search broker, MC or contact". "Filters" › "Risk": Low, Medium, High, Not enough data.
3. Columns: Broker/MC, Status, Loads (Active, Total), Revenue, Avg RPM, Rev / total mi, Profit / Margin, Payment (Terms, Avg days), Overdue (count and amount).
4. Click a row for the drawer: "Overview" (Contact, Address, MC / USDOT, Payment terms, Rating, Status; a red "Flagged do not use" banner with the reason), "Risk" (the grade and the factors that produced it), "Loads", "Financial" (Freight and Payment). Buttons "Open loads", "Open invoices".
5. The row menu (…) offers "Edit" (opens the drawer), "Create load", "Put on hold", "Make inactive", "Make active", "Archive", "Restore".

Notes
- A new broker is "Not rated yet" and its risk is "Not enough data" until it has settled enough loads.
- A do-not-use broker is graded high risk and the reason is quoted.
- Credit limits and factoring details are not kept on the broker record.

Why it won't work
- "Brokers could not be loaded" — retry.
- "Archive is blocked" — "<name> has N active loads. Reassign or complete the loads first."
- "The status could not be changed" — read the message beneath.

## Add a broker

Path: Operations › Brokers (/brokers) › "Add broker" (also /brokers/new) · Permission: brokers.view

Steps
1. Open Operations › Brokers and click "Add broker".
2. "Identity": "Broker name" (required), "MC number" (optional; MC-123456 or just the digits, saved as MC-123456; must be unique), "USDOT" (optional, 5 to 8 digits).
3. "Address": "Street", "City", "State" (two letters), "ZIP" (5 digits or ZIP+4) — all required.
4. "Payment": "Payment terms" — Net 15, 21, 30 (default), 45 or 60.
5. "Contact": "Contact name", "Email", "Phone" (required; a US number formats as (214) 555-0180).
6. "Standing": tick "Do not book freight with this broker" to flag do-not-use; then "Reason" is required.
7. Click "Add broker". Toast: "<name> added — Not rated until they have settled enough loads to grade." (a do-not-use broker: "Flagged do-not-use and placed on hold.")

Why it won't work
- "Broker name is required", "Street address is required", "City is required", "Contact name is required", "Contact phone is required".
- "Enter an MC number such as MC-123456" — MC must be 4–8 digits, optionally with MC-.
- "USDOT is 5 to 8 digits".
- "Use the two-letter state code" / "Enter a 5-digit ZIP" / "Enter a valid email address".
- "Enter a phone number the broker can be reached on".
- "Record why, so the reason shows on the broker risk grade" — Do not use is ticked without a reason.
- "A broker with MC MC-123456 already exists" — the broker is already on file; search by MC.

## Create a broker while adding a load

Path: Operations › Loads › Add load (/loads/new) › "Broker" field · Permission: loads.create

When a rate confirmation comes from a broker that is not on file, create it without leaving the load.

Steps
1. In Add load, type the broker name in "Broker" ("Type a broker name or MC…").
2. If nothing matches, click "+ Create broker “<name>”".
3. "New broker" opens: "Broker name" (prefilled, required), "MC number" (required; MC-123456 or just the digits), optional "Phone", "Email", "Billing address", "City", "State", "ZIP", "Billing email".
4. Click "Create and select". The broker is saved and selected on the load. Toast: "Selected on this load. Payment terms default to Net 30 on their record."

Notes
- "Billing email" is used as the contact email only when "Email" is empty.
- Complete the rest of the broker (USDOT, contact name, terms) later on Operations › Brokers.

Why it won't work
- "Create and select" disabled — Broker name or MC number is empty.
- "A broker with MC MC-123456 already exists" — pick the existing broker in the Broker field instead.
- "Not created" with "Broker could not be created" — retry.
