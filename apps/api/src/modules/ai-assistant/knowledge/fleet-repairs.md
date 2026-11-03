# Fleet: Repairs and work orders

Repairs are recorded as work orders under Fleet › Repairs. The team fixes the truck first and enters the paperwork afterwards, so a work order is usually written straight from the shop's invoice with the status "Completed" (the default). Only a few things can stop a completed repair from saving: the shop, the back-in-service date, the invoice total, at least one line with a system, and a reason when the total is $0. Everything else is optional or is flagged for review after saving. Records are never deleted: a wrong one is voided with a reason.

## The Repair log page

Path: Fleet › Repairs (/fleet/maintenance) · Permission: maintenance.view
Needs to change: maintenance.edit (create, complete, void, upload invoices). Costs and totals are shown only with maintenance_costs.view.

The page title is "Repair log": "Track every repair from opening to completion." It lists every work order on trucks and trailers, active ones first, newest first.

What is on the page:
- Buttons: "Export" (CSV of the rows shown), "Add expense" (only if you may edit fleet expenses) and "Create repair".
- Five tiles: "Active", "Scheduled", "In maintenance", "Completed", "Overdue" ("Across active repairs": not completed and the booked date has passed).
- Segments: "All repairs", "Active", "Completed", "Truck", "Trailer", and "Expenses" (manual fleet expenses, shown to people with maintenance_costs.view or accounting.view).
- Search box "Search order, unit or shop" and a shop filter ("All shops").
- Columns: "Order / opened", "Unit / driver", "Repair description", "Shop / vendor", "Status", "Due / completed", "Cost" (Final or Estimate), "Action".
- Row actions: "View" opens the work order; a file icon opens the invoice on file; "Driver told" appears on a driver charge whose driver has not been told.

Banners you may see:
- "N units are in maintenance with no repair": units set to In shop on the unit itself with no open work order. Click "Unit ... · Create repair" to put the work on record; closing that repair returns the unit to service.
- "N repairs are charged to drivers who have not been told": nothing comes off a driver's pay until somebody tells them. Press "Driver told" on the row once the driver knows.

Statuses shown: "Completed", "In maintenance" (the unit is in the shop, with its stage under it, e.g. "Waiting for parts"), and "Scheduled".

Why it won't work:
- "Nothing matches. Clear the search or the shop." Your search or shop filter hides every row.
- No Cost column: you lack maintenance_costs.view.
- "No repairs on record": nothing has been entered yet.

## Record a completed repair from an invoice

Path: Fleet › Repairs (/fleet/maintenance) › "Create repair" · Permission: maintenance.edit
Also opened from a truck page ("Create repair"), a trailer page ("Create work order"), Fleet › Today ("New repair order") and the "Unit ... · Create repair" buttons.

The form is titled "Create work order". It is the same form for a repair and a work order.

Steps:
1. "Unit (truck or trailer)": type the unit or trailer number. Opened from a unit page, it is filled in and locked.
2. "Type": pick one. There is no default. Choices: Oil change, Annual DOT inspection, PM / mid-trip inspection, Repair, Engine, Electrical harness, Frame issue, Body issue, Steer component, DPF issue, Injector issue, Computer / Module, Accident repair, Tires, Other.
3. "Title": a few words on what was wrong (left blank on a Tires order, it is written from the tires).
4. "Status": leave "Completed" (other choices: "In the shop", "Scheduled into a shop").
5. "Back in service": the day the unit went back on the road. Downtime is measured to this.
6. "Date": when it went into the shop. Left blank on a completed repair, it is the day it came back.
7. "Vendor/shop": search the vendor list. If the shop is not there, type its name and choose + Create vendor "name".
8. "Technician" and "Description" are optional.
9. "Who pays": choose one (see the section on who pays).
10. "What was done": one line per system. Pick the "System" (Body & doors, Brakes, Electrical & lights, Tires & wheels, Engine, Cooling, Exhaust / aftertreatment, HVAC, Suspension & steering, Other, PM / oil change, Fees), type "Work performed" and the "Amount". "Add line" adds more.
11. "Invoice": drop or browse the shop's invoice file. Optional, but without it the record is listed for review.
12. "Invoice total": the total on the invoice. Then "Payment": "Company paid" or "Pay later".
13. Press "Create work order".

What happens after:
- A toast reads "RO-... recorded on <unit>". Without a file it adds "No invoice attached — it is listed for review until one is."
- The repair appears on the Repair log as Completed, on the unit's Maintenance tab and in Costs.
- Lines that do not add up to the invoice total still save and are flagged.
- A Type of Oil change, Annual DOT inspection or PM inspection resets that service clock.

## Why "Create work order" is greyed out or refused

Path: Fleet › Repairs (/fleet/maintenance) › "Create repair" · Permission: maintenance.edit

The button stays disabled until the required answers are given. The reason is shown in red beside it.

Why it won't work:
- "Completed work needs a shop, a back-in-service date, an invoice total and at least one line with a system." The message lists only what is missing. Fill those fields. A line counts only when it has both a System and Work performed.
- "...a reason for the $0 total": with an invoice total of 0, choose "Why $0?" (Covered by the lease, Warranty, Shop goodwill, Done in house).
- "...the odometer at the oil change": a completed Oil change on a truck needs "Odometer (miles)".
- "...at least one tire": a Tires order needs at least one tire picked.
- "Back in service cannot be in the future." Pick today or an earlier date. If the work is not done yet, use status "In the shop".
- "Back in service cannot be before the unit went in." Fix the "Date" or "Back in service".
- "Choose who pays." Pick one of the Who pays buttons.
- No red message but still disabled: the Unit, the Type or the Title is empty, or a driver charge has no driver or no answer to "Has the driver been told about this charge?".
- "Enter an amount of zero or more" under Invoice total: the amount is not a number.

Messages the server can return after you press the button:
- "Back in service cannot be before the unit went into the shop"
- "Enter the odometer (miles) at the oil change"
- "This oil change is already recorded as RO-.... Open it to correct it instead of adding another."
- "A driver charge needs a driver: this unit has nobody on it, so pick the driver to charge"
- "Say whether the driver has been told about this charge"
- "Say what was done before completing it"

## Who pays for a repair (Company, Driver charge, Under investigation, Warranty claim)

Path: Fleet › Repairs (/fleet/maintenance) › "Create repair" › "Who pays" · Permission: maintenance.edit
Changing who pays later: maintenance.edit, or compliance.manage to settle an Under investigation repair.

Every new repair must say who pays. Nothing is chosen for you.
- "Company expense": goes to the company's books.
- "Driver charge": taken off what that driver earned, but only once the driver has been told. "Driver charged" fills itself with the driver on the unit; pick another if needed. Then answer "Has the driver been told about this charge?": "Driver informed" (accounting deducts it) or "Not informed yet" (the charge is held and flagged).
- "Under investigation": nothing comes off anyone's pay. Optionally name the "Driver in question". It shows on Costs, on the unit and on the driver until a fleet manager or Safety decides Company or Driver.
- "Warranty claim": flagged for a claim with the maker or the shop; Costs counts it under Warranty, apart from company spend.

After saving:
- A held driver charge shows "Driver not informed" on the Repair log. Press "Driver told" when the driver knows. The toast says "Driver informed" and accounting may then take it off their pay.
- An Under investigation repair is settled from Fleet › Costs ("Under investigation" list, "Settle").

Why it won't work:
- "Nobody is assigned to this unit, so the driver has to be named." Pick the driver in "Driver charged".
- "You cannot change who pays for a repair": you lack maintenance.edit (Safety may only settle an investigation).
- "That driver is not on the roster": the driver was removed; pick another.

## Payment terms and $0 repairs

Path: Fleet › Repairs (/fleet/maintenance) › "Create repair" · Permission: maintenance.edit

Under "Invoice total" the form asks "Payment":
- "Company paid": paid at the shop, nothing owed.
- "Pay later": counts in "Unpaid vendor bills" on Costs until Accounting pays it.
Payment is optional. It is not asked when the total is $0.

A $0 total needs "Why $0?": "Covered by the lease", "Warranty", "Shop goodwill" or "Done in house". Without it the form says "Completed work needs a reason for the $0 total." and the server says "A $0 invoice needs a reason".

## Record an oil change as a repair (odometer)

Path: Fleet › Repairs (/fleet/maintenance) › "Create repair", Type "Oil change" · Permission: maintenance.edit
The same record can be made on PM & inspections › Oil change / PM with "Log oil change".

When the Type is Oil change, the status is Completed and the unit is a truck, the form asks "Odometer (miles)": "The mileage on the invoice. The Oil change board counts the next oil change from it" (the current ELD reading is shown as a hint). This reading becomes the oil change board's new starting point.

Why it won't work:
- "Completed work needs the odometer at the oil change." Enter the miles (digits, commas allowed).
- "This oil change is already recorded as RO-.... Open it to correct it instead of adding another." The same truck already has an oil change near that date. Open the existing record instead.
- Completing an open oil-change order: "This oil change is already recorded as RO-.... Void this one instead of completing it."

## Tire work order and tire positions

Path: Fleet › Repairs (/fleet/maintenance) › "Create repair", Type "Tires" · Permission: maintenance.edit
The old link /fleet/maintenance/tire-work-order opens this form with Tires chosen.

With Type "Tires" the lines and total are replaced by a tire map ("Tire positions": "Click each tire worked on").
Steps:
1. Pick the unit, then click each tire on the map, or use the quick buttons: "Both steers", "All drive", "Drive axle 1", "Drive axle 2", "All trailer", "Trailer axle 1", "Trailer axle 2".
2. On a truck, tick "Show trailer" and choose the trailer to work on its tires too.
3. For each tire set "Work" (Replace · new, Replace · used, Repair · patch, Repair · valve/stem, Rotate), "Brand · model", "Reason", "Tread (32nds)" and "Tire cost ($)". A copy button copies one tire's answers to all selected tires.
4. Enter "Labor (total, $)" (split equally across the tires) and "Fees / shop supplies / tax ($)" (booked under Fees, not Tires).
5. The "Invoice total" fills itself from the tires, labor and fees. Fill the rest of the form and press "Create work order".

A tire on the trailer is filed to the trailer, not to the truck that pulled it.

On other repairs with a "Tires & wheels" line, a smaller "Tire positions" map appears, read from the description ("Read from the description - check them."). Choose "Replaced", "Blowouts" or "Patched / repaired". It never blocks saving; tires that could not be placed are listed for review.

Why it won't work:
- "Completed work needs at least one tire." Pick a tire on the map.
- "No tires selected. Pick positions on the map, or use the quick buttons (e.g. Both steers)."
- "A tire is filed to a trailer that is not in this company": choose a trailer from your own fleet.

## Open a work order for a unit going into the shop

Path: Fleet › Repairs (/fleet/maintenance) › "Create repair", Status "In the shop" or "Scheduled into a shop" · Permission: maintenance.edit

Use this when the work is not finished yet.
- "In the shop": the unit is out of dispatch while the shop has it and shows "In maintenance" on Trucks / Trailers. "Date" is when it went in (blank = today). A trailer in a shop is marked unavailable and detached from its truck; the truck stays dispatchable.
- "Scheduled into a shop": "Date" is when the shop has it. The unit stays in dispatch until then.
Shop, invoice and total are optional for these statuses.

Toasts: "RO-... opened" with "The unit is out of dispatch while the shop has it." or "The unit stays in dispatch until the shop has it."

Track progress on the work order page (Fleet › Repairs › "View"), card "Where it is now": tap the stage reached: "Diagnosing", "Waiting for approval", "Waiting for parts", "In repair", "Quality check / road test", "Ready for pickup". A "Note" is optional and kept with the stage.

Finish it in the "Close it out" card: type "What was done" (required), optionally "Odometer out" (trucks), and press "Complete". Completing stops the downtime clock, returns the unit to service and resets the matching service.

Why it won't work:
- "Say what was done before completing it." Fill "What was done".
- "It cannot come out of the shop before it went in"
- "That work order is already completed"
- "That work order is completed; its stage cannot change"

## The work order page: invoice, notes and reopening

Path: Fleet › Repairs (/fleet/maintenance) › "View" (/fleet/shop/<id>) · Permission: maintenance.view
Needs to change: maintenance.edit. Reopening needs trucks.edit (fleet manager or administrator).

The page shows a banner ("Repair completed", "Scheduled into a shop" or "In the shop · <stage>"), tiles "Status", "Downtime" and "Odometer", the "What was done" lines, "Record details" and a read-only "Activity" history.

Actions:
- "Upload invoice": enter "How much it cost ($)", "Shop invoice #" and drop the file (PDF or photo), then "Upload". The record's total follows the invoice and the missing-paperwork flag clears. "View invoice" opens the file on the page.
- "Add note": type and "Save note"; each note keeps who and when.
- "Reopen repair" (completed records only): give a "Reason" and press "Reopen repair". The order goes back to the shop at "In repair".
- "Void work order": see the void section.

Why it won't work:
- "Reopening a completed work order is a fleet manager's action." / "Only a fleet manager or administrator can reopen a work order": you lack trucks.edit.
- "That work order is not completed": only completed orders reopen.
- "That work order is voided; it takes no notes"
- "That file was not uploaded": upload the file again.
- "That work order could not be opened": it does not exist or was not readable; go back to the Repair log.

## Void a work order entered by mistake

Path: Fleet › Repairs (/fleet/maintenance) › "View" › "Void work order" · Permission: maintenance.edit

Use void for a duplicate or a record entered by mistake. Nothing is deleted: the record stays, marked with who, when and why, and stops counting in lists, spend and the dashboard. An oil change's mileage reading is withdrawn with it.

Steps:
1. Open the work order and press "Void work order".
2. Type a "Reason" (at least 3 characters), for example "Duplicate of RO-2026-1033."
3. Press "Void work order". The page shows "Voided <date> by <name>".

Why it won't work:
- Button disabled: the reason is shorter than 3 characters ("Say why it is being voided").
- "The unit is still in the shop on RO-.... Complete it first, then void it."
- "RO-... is charged to a driver. Change "Who pays" to the company first, so the driver's deduction is withdrawn."
- "RO-... is billed in Accounts Payable as <bill>. Void that bill first." Ask Accounting to void the bill.
- "RO-... is already void"

## Duplicate repair warning

Path: Fleet › Repairs (/fleet/maintenance) › "Create repair" · Permission: maintenance.edit

Before saving, the form checks the unit's existing work orders. If one has the same shop, within 7 days, and the same total (or the same description when totals are not visible), it asks "This looks like RO-...": "... already records this repair on the same unit, at the same shop, <date>. Save a second one only if it is really a separate repair."
- "Don't save": go back and check the existing record.
- "Save anyway": two real repairs a few days apart are allowed.

It never blocks; it only asks. If you saved a true duplicate, void one of them (Void work order, reason "Duplicate of RO-...").

A manual expense on Costs can also say "This looks like repair RO-..., already in Maintenance. Open it there instead of entering it again, or confirm this is a different cost." Tick "This is a different cost" only if it really is.

## Trailer repairs and units in maintenance without a repair

Path: Fleet › Trailers › trailer page (/fleet/trailers/<id>) › "Create work order" · Permission: maintenance.edit

Trailer work belongs to the trailer, not to the truck pulling it. Open the work order on the trailer (pick the trailer number in "Unit (truck or trailer)", or use "Create work order" on the trailer page). Its spend then shows on the trailer and under Trailers on Costs. On a truck's Tires order, trailer tires are filed to the trailer automatically.

The trailer page's "Maintenance" tab lists "Trailer work orders".

Units in maintenance with no repair: a unit whose status was set to In shop on the unit itself, with no open work order, shows on the Repair log as "N units are in maintenance with no repair" and on the truck's Maintenance tab as "Unit ... is in maintenance with no work order". The shop, the work and the cost are not on record. Press "Create repair" there; completing the repair returns the unit to service.
