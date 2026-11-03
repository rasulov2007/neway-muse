# Fleet: units, costs, PM, inspections, fuel and vendors

The Fleet menu is where the company keeps its trucks and trailers running and knows what they cost. It has eight items: "Costs" (every fleet cost and who bears it), "Today" (what needs a decision now), "Trucks", "Trailers", "Repairs" (work orders, see the repairs guide), "PM & inspections" (with "Oil change / PM" and "Pre-trip board"), "Fuel" and "Vendors". Repairs are entered after the job, straight from the invoice. Nothing is deleted: units are archived or taken off the road with a reason, and wrong records are voided.

## What each Fleet menu item is for

Path: Fleet (sidebar group) · Permission: depends on the item

- "Costs" (/fleet) · maintenance_costs.view: total fleet spend, maintenance and manual expenses, who bears it, the Under investigation list.
- "Today" (/fleet/today) · maintenance.view: eight numbers and the "Needs a decision today" list.
- "Trucks" (/fleet/trucks) · trucks.view: the truck register, statuses, assignments.
- "Trailers" (/fleet/trailers) · trailers.view: trailer register and inspections.
- "Repairs" (/fleet/maintenance) · maintenance.view: the Repair log of work orders.
- "PM & inspections" · maintenance.view: "Oil change / PM" (/fleet/oil-change) and "Pre-trip board" (/fleet/pti).
- "Fuel" (/fleet/fuel) · maintenance_costs.view: fuel transactions and fuel invoices.
- "Vendors" (/fleet/vendors) · maintenance.view: shops, dealers, tire services and other vendors.

Old links still work: /fleet/costs and /fleet/expenses open Costs; /fleet/repairs opens Repairs; /fleet/pm opens Oil change / PM.

Why it won't work:
- A menu item is missing: your role lacks the permission listed above. Ask an administrator.
- Money columns or figures are missing on Repairs or Today: you lack maintenance_costs.view.

## The Costs page: total spend and who bears it

Path: Fleet › Costs (/fleet) · Permission: maintenance_costs.view

"Costs" shows "Every fleet cost in one place: maintenance and expenses, and who bears them."

Controls at the top: period "Week", "Month", "Quarter", "Year" with a picker for which one; "All units" / "Trucks" / "Trailers"; a shop filter ("All shops"); "Export" (CSV).

Figures:
- "Total fleet spend" (with Maintenance and Expenses beneath), "Maintenance cost per mile", "Average per truck", "Open repair estimates" (open repairs, not in spend yet).
- Expense figures (maintenance_costs.view or accounting.view): "Under investigation", "Company cost", "Driver charge outstanding", "Unpaid vendor bills" (company-paid, not paid yet, e.g. repairs marked Pay later), "EFS recovery remaining". Clicking a figure opens the expense list filtered to it (/fleet/expenses/list).
- "Who bears it": Company, Driver, Investigation, Warranty (and Owner when present).

Panels: "Spend by category" (click a category to open its page; the Tires category shows the "Tire position map"), "Monthly fleet spend", "Spend by truck", "Vehicle spend breakdown" (work order, unit, top category, total), "Expense breakdown" (manual expenses with "Charge to"), and "Leaks — money and time we can get back".

Why it won't work:
- "No spend in this period": nothing completed in the chosen period. Change the period.
- "No expenses in this period": no manual expenses (cash advances, parking, tolls, washes) in it.
- Expense figures missing: you need maintenance_costs.view or accounting.view.

## Settle a repair or expense that is Under investigation

Path: Fleet › Costs (/fleet) › "Under investigation" · Permission: maintenance_costs.view, accounting.view or compliance.manage to see
Needs to change: maintenance.edit or compliance.manage

"Under investigation" means nobody has decided yet whether the company or a driver bears a cost. Nothing is deducted and nothing is posted to Accounting until it is settled. The list also shows on the truck's Maintenance tab. Items older than 30 days show "Overdue · N days".

Steps:
1. On Costs, click the "Under investigation" figure or scroll to the list.
2. Press "Settle" on the item.
3. "Who bears it": Company or Driver.
4. For Driver: pick "Driver charged"; for a repair also answer "Has the driver been told?" (Told: accounting deducts it. Not told: it is held until somebody tells them).
5. Type "What the investigation found" (at least 3 characters) and press "Settle".

A repair is settled through its own Who pays, so its history stays on the work order.

Why it won't work:
- "Settle" disabled: choose who bears it, give a reason of 3+ characters, and for Driver pick the driver (and answer told / not told on a repair).
- "Say what the investigation found"
- "<reference> is not under investigation any more. Reload it."
- "<reference> was changed by someone else. Reload it and try again."
- "You cannot change who pays for a repair": you lack the permission to change it.

## Add a manual fleet expense (cash advance, parking, tolls, wash)

Path: Fleet › Repairs (/fleet/maintenance) › "Add expense", or Fleet › Costs › expense list (/fleet/expenses/list) › "Add expense", or a truck's "Expenses" tab · Permission: maintenance_costs.view or accounting.view
Needs to change: maintenance.edit or accounting.edit. Posting to Accounting needs accounting.edit.

An expense is "One cost on one truck: what it was, who paid it and who bears it." Categories: Cash advance, Parking, Truck Wash, Repair/Maintenance, Tolls, Fuel, Permits, Scale, Lumper, Supplies, Other.

Steps:
1. Press "Add expense".
2. "Expense": "Truck", "Category", "Expense date", "Amount", "Vendor / payee", "Invoice #".
3. "Location" (required for Parking: the parking name and the address or city and state).
4. "Payment and charge": "Paid by" (Company, Driver, Owner), "Payment method", "Already paid?" (Paid / Unpaid), then "Charge to" (Company, Driver, Under investigation). For Driver: "Driver", "Charge amount", "Reason", "Deduct from settlement".
5. EFS payments ask "Issued amount" and "Used amount"; only the used amount is spend.
6. Attach receipts under "Documents".
7. "Save expense" (counts as spend) or "Save draft" (counts nowhere until saved as an expense).

Open an expense from the list to "Preview PDF", "Download PDF", "Edit", "Void" or "Post to Accounting".

Why it won't work:
- "Choose the truck." / "Choose the category." / "Enter an amount above $0.00."
- "Parking needs the parking name." / "Parking needs the location or address."
- "An unpaid expense becomes a vendor bill: enter the vendor."
- "Choose the driver the charge is for." / "Say why the driver bears this cost." / "The charge cannot be more than the expense."
- "Under investigation is for money the company paid out: Paid by must be Company."
- "EFS is company money: Paid by must be Company." / "For EFS the amount is what was actually used."
- "This looks like a repair already in Maintenance. Open it, or tick “This is a different cost”."
- Posting: "<ref> is under investigation: decide who bears it (Company or Driver) before it goes to Accounting." / "<ref> is unpaid: choose the vendor on file so Accounting can create the bill."
- Editing after posting: "<ref> is posted to Accounting: ... cannot change here. Void it ... or correct it in Accounting."
- Voiding: "A void needs a reason." / "$... was already deducted from the driver. Reverse those deductions first." / "Vendor bill ... has payments. Credit or refund it in Payables first."

## Fleet today: what needs a decision

Path: Fleet › Today (/fleet/today) · Permission: maintenance.view

"Fleet today" answers which trucks are not earning and what to do first. Buttons: "Pre-trip board" and "New repair order" (opens the Create work order form).

Eight tiles (click one to open its board): "Oil change overdue", "Oil due ≤ N mi", "PTI issues unresolved", "Walk-arounds missing", "Waiting on parts", "Documents holding dispatch", "In the shop now", "DOT inspections within 30 days". A red badge "N cannot be dispatched" appears when units are held.

"Needs a decision today" lists the worst items first, filtered by "Oil", "Shop", "Documents", "PTI" or search. Each row has one action:
- Documents: "Dispatch held" · "Attach document" (opens Safety for that unit or driver).
- Oil: "Overdue" · "Book oil service" or "Log oil change" (opens the Oil change board).
- PTI: "Out of service" or "Open defect" · "Assign owner" (opens the Pre-trip review).
- Shop: "Past promised" or "Waiting on parts" · "Open order".

Side panels: "In the shop" (unit, service provider, status, due date) and "This month's spend" (with a link to Costs).

Why it won't work:
- "Nothing needs a decision today." Nothing is late.
- "Documents holding dispatch" says "not readable for your role": you cannot read compliance.
- Numbers say "Loading…": wait; they come from each board.

## Trucks list and truck statuses

Path: Fleet › Trucks (/fleet/trucks) · Permission: trucks.view
Needs to change: trucks.edit

"Trucks": "Manage fleet availability, assignments and maintenance." Tabs: "The fleet", "Off the road" (units taken out of service, made inactive or sold, with the account of what happened), "Archived".

The strip at the top counts trucks by availability: "Available" (of N total), "Assigned", "Inactive", "In maintenance", "Needs attention", "Out of service". Click one to filter. Filters: "Type", "Location", "Driver" (Driver assigned / No driver), "Maintenance" (Overdue, Due soon, Scheduled, On schedule, No interval), "Status", and "PTI" ("PTI issue": only trucks with a pre-trip defect not yet fixed; see "PTI issue badge on trucks, trailers and the Daily board").

Availability comes from the facts: a load, a driver, an open work order in the shop ("In maintenance"), or a status set by hand. Click a status badge to change it: "Take out of service", "Make inactive", "Return to service", "Reactivate". Taking a unit off the road opens a form asking "Reason" (Sold, Stolen, Fire, Accident, Totaled, Mechanical failure, Returned, Retired, Other), "Date" and "Account", plus sale, theft, damage and insurance details.

Row menu: "Open unit", "Assign driver or trailer", "View current assignment", "Schedule maintenance", "Open work order".

Why it won't work:
- "Say what happened — the reason on its own is not an account" — fill "Account".
- "<driver> is still assigned to unit .... Move them off it first." — unassign the driver before Out of service.
- "Make inactive is blocked": the unit has active loads. "Reassign or complete the loads first."
- "Unit ... is archived. Restore it first."

## Add a truck

Path: Fleet › Trucks (/fleet/trucks) › "Add truck" · Permission: trucks.view
Needs to change: trucks.create or trucks.edit

Steps:
1. Press "Add truck" (beside the filters).
2. "Truck information": "Unit number" (2 to 8 characters), "VIN" (17 characters, no I, O or Q), "Make", "Model", "Year".
3. Optional: "Plate" and "State", "Ownership" (Company owned, Leased, Owner-operator, Vendor truck), "Home location", "Assigned driver", "In service since".
4. "Status" and "Odometer" are required.
5. Optionally attach documents. Press "Create truck".

The truck opens on its own page: "Unit N added". A first PM booking is created. A file that fails to upload is named in a warning; attach it again from the Documents tab. Trailers are added under Fleet › Trailers.

On the truck page, banners ask for missing details: "Add in-service date", "Add plate".

Why it won't work:
- "Unit N already exists in the fleet" / "A truck with VIN ... already exists"
- "VIN must be 17 characters with no I, O or Q", "Year must be 1995 or later", "Odometer is required", "Select a make", "Model is required"
- "That driver is not on the roster" / "<driver> is already on unit ..."
- "A unit that is in a shop or out of service cannot start with a driver on it"

## The truck page: tabs, documents and history

Path: Fleet › Trucks › unit (/fleet/trucks/<id>) · Permission: trucks.view
Needs to change: trucks.edit (status, archive), maintenance.edit (repairs)

The header shows "Unit N", its status verdict and the line saying why. Buttons: "Create repair", "Schedule maintenance", and a "More actions" menu (status changes, "Archive truck" / "Restore truck").

Tabs: "Overview", "Driver" (Assigned driver panel), "Load", "Tracking", "Maintenance" (Under investigation items, "Work orders", "Vehicle condition", "Service schedule"), "Expenses" (manual expenses, "Add expense"), "History" (repairs, accidents and violations; filters All / Repairs / Accidents / Violations and a period), "Documents", "Performance", "Notes", "Activity".

The next-service card shows the oil change interval with "Set interval" or "Change".

Add a document:
1. Open the "Documents" tab and press "Add document" (or drop a file on the card).
2. Choose "Document type", the "Document file" (PDF or image, max 20 MB), optional "Issue date (optional)", "Expiry date", "Issuing state / authority", "Note (optional)".
3. Press "Add document". Expired or missing documents can hold dispatch.

Archive: "Archive truck" asks a "Reason". The unit leaves every list, picker and count; history keeps its number. "Restore" brings it back as available.

Why it won't work:
- "Choose the file first" / "Choose the document type" / "<type> expires — enter the expiry date" / "That file is larger than 20 MB."
- "Say why the truck is archived"
- "Cannot archive: <driver> is still assigned to unit ...; move them off it first." or "...is on active load ..."
- "That unit is not in the fleet": wrong link.

## Assign, change or unassign a truck's driver

Path: Fleet › Trucks › unit (/fleet/trucks/<id>) › "Driver" tab › "Assigned driver" · Permission: trucks.view
Needs to change: trucks.edit or truck_assignment.edit

Steps to assign:
1. On the "Driver" tab press "Assign driver".
2. Pick the "Driver" (search by name or driver number), the "Assigned date" (the day the driver took the unit).
3. Tick "Handed over with the unit": Tablet, GPS, ELD, Fuel card, Toll tag, Keys, Other.
4. Optional "Pickup photos" and "Note". Press "Assign driver".

With a driver in the unit, the panel shows "Edit", "Change" (swap to a new driver; the previous one's drop is recorded) and "Unassign" ("Unassigned / drop date", "Returned with the unit", "Drop photos", "Drop note"). "Earlier drivers" lists the history. A wrong entry can be voided with a reason.

Why it won't work:
- "Pick the driver"
- "The assigned date cannot be in the future." / "The drop date cannot be in the future." / "The drop date cannot be before the assigned date."
- "<driver> is already in unit N. Use Change to edit the assignment."
- "Unit N is archived. Restore it before assigning a driver." / "Unit N is out of service and cannot be assigned"
- "<driver> is <status> and cannot be put in a unit"
- "This driver is still in the unit. Unassign them before voiding the entry."
- "This assignment was changed by somebody else; reload and try again"

## Trailers: list, add and trailer page

Path: Fleet › Trailers (/fleet/trailers) · Permission: trailers.view
Needs to change: trailers.edit

"Trailers": "Trailer availability, assignments and inspections." Columns: "Trailer / Type", "Status", "Availability", "Current load", "Truck / Driver", "Location", "Next inspection", "Last update". A trailer has no telematics of its own; its position is the truck pulling it. Filters: "Status", "Type", "Assignment" (On a truck / Unassigned).

Add a trailer: press "Add trailer"; fill trailer number (2 to 8 characters), VIN, make, model, year (1990 or later), "Type" (dry van, reefer, flatbed), length (20 to 60 ft); plate, state, ownership and next inspection date are optional. Press "Add trailer".

The trailer page has tabs "Overview", "Assignment", "Maintenance" ("Inspection details", "Trailer work orders") and "Documents", and the buttons "Create work order" and "More actions" ("Make inactive", "Take out of service", "Return to service", "Reactivate"). "Edit" on the "Trailer information" card changes the make, model and year. Trailer repairs belong to the trailer, not the truck pulling it.

Why it won't work:
- "Trailer N already exists in the fleet" / "A trailer with VIN ... already exists"
- "Select a type", "Length must be 20 ft or more", "Make is required", "Model is required"
- A trailer missing its annual inspection date shows "Add inspection date".

## Oil change / PM board: book and log oil changes

Path: Fleet › PM & inspections › Oil change / PM (/fleet/oil-change) · Permission: maintenance.view
Needs to change: maintenance.edit

"Oil changes" is mileage-driven. A booked service does not un-overdue a unit already past its limit. Tiles: "Overdue", "Due ≤ N mi", "On schedule", "All trucks" (trailers have no oil interval). Columns: "Unit", "Odometer", "Last change", "PM mileage", "Due at", "Service status", "Shop", "Action". Header buttons: "Truck types" (oil interval per truck type) and "Log oil change".

Row actions: "Book", "Log", or "Get reading" (no odometer reading).

Book ("Schedule oil change"): pick the unit, "Shop", "Date and time", "Responsible", optional "Estimated cost", "Notify", "Note for the shop"; press "Save appointment" (or "Move appointment"). It creates a work order "Scheduled into a shop"; dispatch sees a 2-hour hold.

Log ("Record oil change"): "Service date and time", "Odometer at service" (from the invoice), "What was done" ("Oil & filter change" is required), "Other work on this invoice", "Shop", "Total on the invoice", "Invoice #", the invoice file. Press "Save as completed". This is the only thing that resets the clock.

Why it won't work:
- "Pick a unit first", "Pick a shop", "Pick a date and time", "Pick who is responsible"
- "Enter the odometer at the service", "Oil and filter is required for a reset", "Enter the total on the invoice", "Say why the invoice is $0"
- "Attach the invoice: the record cannot be completed without it"
- "The odometer is N miles from the ELD. Say why before saving."
- "<unit> is already booked on RO-... Say so to move it." / "<unit> is already in the shop on RO-..."
- "Invoice ... from <shop> is already on RO-..." / "This oil change is already recorded as RO-.... Correct that one instead of adding another."
- "The service time is in the future"
- Get reading: "That is below the last reading of N mi. An odometer does not go backwards..."

## Pre-trip board: weekly walk-around videos and review

Path: Fleet › PM & inspections › Pre-trip board (/fleet/pti) · Permission: maintenance.view
Needs to change: maintenance.edit or safety.manage. Clearing a repaired defect needs safety.manage.

"Pre-trip inspections" shows one week at a time (arrows change the week). Counters are filters: "Open issues" (N holding a truck), "Nothing sent" (chase the driver), "To review" (sent, nobody looked), "Clean", plus a drivers tile. Row statuses: "On hold", "N issues", "Repaired", "In shop", "Not due", "Missing", "Issue found", "No issues", "Not reviewed", "Awaiting". Row buttons: "Review", "Chase driver", "Open", "Confirm & clear", "View".

Review a truck (drawer "PTI review · Unit N"):
1. If the video is not marked yet, set "Video" to "Received" with the date (or "Missing").
2. Choose "No issues" (rate each component "Good", "Soon", "Now" or "—" couldn't see; "Mark all good") or "Issue found".
3. For an issue: "Component", "What's wrong", "Urgency" ("Watch", "Soon", "Urgent"); Urgent needs a screenshot. Press "Add this issue".
4. For open issues, say what the video showed: "Still there", "Looks fixed", "Couldn't see".
5. Press "Save". An Urgent issue puts the truck on hold and notifies dispatch.

Open issues have a "Fixed" button. Safety's Fixed also clears it; anyone else's waits for Safety's "Confirm & clear".

Why it won't work:
- "Choose No issues or Issue found", "Add at least one issue, or choose No issues"
- "Choose the component.", "Say what is wrong in a short line.", "An urgent issue needs a screenshot from the video."
- "Say what this video showed for ... before saving a clean review"
- "Verifying a repair takes safety.manage"
- "Somebody saved this record after you opened it. Reload and try again."

## PTI issue badge on trucks, trailers and the Daily board

Path: Fleet › Trucks (/fleet/trucks), the truck page, Fleet › Trailers (/fleet/trailers), Dispatch › Daily board (/dispatch/daily) · Permission: trucks.view

What it is for: a unit with a pre-trip (PTI) defect that is not fixed yet says so beside its status, so dispatch and the shop see it without opening the Pre-trip board.

Where it shows
- Trucks list, "Status" column, and the truck page header: a badge "PTI issue" (or "2 PTI issues"). Click it to open the truck's Maintenance tab, where its open defects are listed.
- Trailers list, status cell: the same badge, for defects recorded on the trailer itself (not on the truck pulling it). Not clickable.
- Daily board, truck column: a small "PTI" mark with its symbol. Not clickable.
- Hover any of them for the list of defects, worst first, each as "<component>: <description> (<severity>, <state>)". If the worst one is out-of-service risk the first line ends "· out-of-service risk".

Colour and symbol: red octagon for "Out-of-service risk" or "Replace now"; amber diamond for "Monitor" or "Replace soon".

Filter: on Fleet › Trucks choose "PTI" › "PTI issue" to list only trucks with the badge. "Clear filters" resets it.

When a unit gets it and when it goes away
- Any PTI defect in state Open, Assigned, Scheduled or In repair gives the badge, at any severity.
- A defect "Fixed — awaiting verify" still counts only when it is out-of-service risk (the hold has not lifted yet).
- The badge goes away when every such defect is verified or dismissed (or, for a non-out-of-service-risk defect, marked fixed). Work the defects on Fleet › PM & inspections › Pre-trip board.

Why it won't work
- No badge or filter anywhere: the Fleet v2 screens are not switched on for this company.
- The badge is still there after the repair: the defect must be verified on the Pre-trip board (an out-of-service-risk defect stays until verified). The screen refreshes within a minute.

## Fuel transactions and invoices

Path: Fleet › Fuel (/fleet/fuel) · Permission: maintenance_costs.view

"Fuel" shows fuel spend for a date range: tiles "Fuel spend", "Gallons", "Cost per gallon", "Trucks fueled", and a warning for units without measurable MPG. Tabs: "Transactions" and "Invoices". Filters: "Truck", "State", "Vendor", "Product", "Flagged" (Flagged only). Click a row to see "Selected transaction" (station, gallons, price, odometer, unit MPG, card, flags, invoice). "Export" downloads a CSV.

Add a fill that did not come through the card feed:
1. Press "Add fuel" ("Add fuel transaction").
2. "Truck", "Product", "Gallons", "Price per gallon", "Odometer" (without it the fill counts toward spend but gives no MPG), "Vendor", "Station", "City", "State", "Card last 4".
3. Press "Record fill". Unusual fills are flagged.

Fuel purchases here also reach driver pay: when Accounting creates or updates the week's statements, each purchase becomes a "Fuel · station · city · gal" line on the driver's statement, deducted only if the driver's profile deducts fuel (see "Fuel purchases on driver statements").

Why it won't work:
- "Record fill" disabled: truck, gallons above 0, price above 0, vendor, city and a two-letter state are required.
- "That unit is not in the fleet"

## Vendors: add, name and merge shops

Path: Fleet › Vendors (/fleet/vendors) · Permission: maintenance.view
Needs to change: maintenance.edit for naming and merging shops

The page lists vendors ("Vendor", "Type", "Phone", "City", "Work orders", "Total spend", "Last used", "Status") with "Most visited" and "Most spent" in the header.

Add a vendor: press "Add vendor" ("Create vendor"). Only "Name" is required. Optional: "Type" (Shop, Dealer, Tyre service, Mobile repair, Parts supplier, Towing, Fuel, Tolls, Insurance, Leasing...), phone, email, website, "Our account number with them", address, "Payment terms (days)" (default 30), "Status", "Notes", "Additional contacts" (offered as technician suggestions). Press "Create vendor". A shop can also be created from the repair form's "Vendor/shop" field (+ Create vendor "name").

Name shops: a box "N shops named by their address" lists imported shops with only an address. Type the real name (e.g. Love's Truck Care) and press "Save"; their repairs and oil changes show it too.

Merge duplicates: open the vendor, press "Merge into…", pick "Keep this vendor", give a "Reason" and confirm. Its work orders move to the kept vendor; the old record is hidden.

Why it won't work:
- "A vendor needs a name" / "<name> is already on the vendor list"
- "Pick a different vendor to merge into" / "Say why"
- "Someone changed this shop since you opened it. Reload and try again."
