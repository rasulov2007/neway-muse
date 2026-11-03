# Loads and tracking

Loads is where freight is booked, assigned, moved stop by stop, documented and handed to billing. Every load starts from a rate confirmation (RC), carries its stops with their own local times, and moves through statuses only by recorded events (arrival, departure, BOL, POD) or by the Daily Board. Tracking is the live map of trucks and the loads they carry.

## Loads list: views, numbers, filters and the needs-attention bars

Path: Operations › Loads (/loads) · Permission: loads.view

The Loads page is the register of all freight. It shows a "Live" badge once data has arrived (it refreshes every 30 seconds).

What is on the page, top to bottom:
1. Five number cards: "Loads" (with "N delivered · N booked"), "Revenue" (cancelled loads left out), "Loaded miles" (with deadhead), "Avg RPM" (revenue ÷ loaded miles) and "Active drivers" (with their units). They count every load, not just the current view. While loading they say "Loading…".
2. Needs-attention bars (only when something needs attention): "Will miss appointment", "At risk", late loads, "Missing assignment" (assign a driver or unit), "Tracking unavailable" (position too old to verify ETA) and "Upcoming appointments" (due within 4 hours). Each bar names up to two load numbers and a count. Click "View" on a bar to filter the table to that view (click again to clear). "Upcoming appointments" opens the dispatch page instead.
3. The view bar, one choice at a time, each with a count: "All", "Booked", "Unassigned" (booked or assigned with no driver or no truck), "Assigned" (assigned or dispatched), "In transit" (at pickup through unloading), "At risk", "Late", "No update", "Ready to bill" (delivered, POD on file, no invoice yet, no open flag), "Delivered" (delivered or completed), "Cancelled" (cancelled or TONU), "Flagged" (open flag) and "My loads" (you are the dispatcher or updater).
4. The table: "Load / Status" (status badge, a paperwork-missing chip, a red "Flagged" tag), "Customer / Broker", "Route", "Pickup", "Delivery" (in the stop's own time zone), "Driver / Unit" ("Unassigned" in amber when empty), "Equipment", "Miles" (total and deadhead "DH"), "Revenue". "Insufficient data" means a figure could not be calculated; hover to see what is missing.

Steps to find a load:
1. Type in "Search load #, reference, customer..." (searches load number, customer reference, customer, broker, driver, unit, origin and destination city, commodity).
2. Click "Filters" to pick "Customer", "Broker" or "Equipment"; "Clear filters" resets them.
3. Click a row to open the load. The row's "⋯" menu has "Attach files", "Open load", "Edit", "Paperwork" and "Recover load".
4. "Export" downloads the rows shown as a CSV; select rows and use "Export selected" for only those.

The worst-risk loads are listed first, then by soonest delivery.

Why it won't work
- "No loads found" — the view, search or filters leave nothing. Pick "All" and clear the search and filters.
- The page is empty or shows an error — you may lack loads.view; ask an administrator.
- Export is greyed out — the table has no rows in the current view.
- The "Flagged" or "My loads" chip shows a count but the table is empty — the table currently does not apply those two views. Use "All" and look for the red "Flagged" tag, or search by your loads.

## Add a new load (book a load from the rate confirmation)

Path: Operations › Loads (/loads) › "New load" button (opens the "Add load" window); also the page /loads/new ("Book a load") · Permission: loads.create
Needs to change: loads.create (and loads.edit for the co-driver and the RC filing)

Every new load needs its rate confirmation. The load number is generated on save (shown under "Load number" as "Generated on save.").

Steps:
1. On Loads click "New load".
2. In "Rate confirmation (RC) *" drop the RC or click "Browse files" (PDF, JPG or PNG). The RC reader fills the form if it can (see "Fill a load from the rate confirmation (RC reader)").
3. "Customer & reference": pick the "Broker" (type a name or MC) and type the "Customer Reference #" — both required for a new load.
4. "Load details": "Equipment" (Dry van, Reefer, Flatbed, or leave "Not given") and "Hazmat".
5. "Assignment" (all optional): "Driver" (the unit they are on fills "Truck" and "Trailer #" automatically), "Co-driver (team)", "Truck", "Trailer #". "Dispatcher" is you, the person booking.
6. "Stops": fill the Pickup and Delivery cards — "Facility", "Street", "City", "State", "ZIP" and "Appointment". Use "Add stop" for more stops.
7. "Rates & freight": "Rate ($)" and "Loaded miles" are required; "Empty miles (DH)" and "Weight (lb)" are optional. Miles fill themselves from the stops and the driver's last delivery; "Use N mi" offers the calculated figure. Revenue per mile shows live.
8. Optional "Notes".
9. Click "Create load & attach RC" (it reads "Create Load" until an RC is chosen).

What happens after:
- With no driver the load is Booked and shows as unassigned. With a driver chosen at booking it starts as Dispatched straight away.
- The RC is filed in the load's Documents as Received, awaiting review. Toast: "Load L-… booked".
- If the truck has an open out-of-service defect, a window "Unit … is out of service" asks "Why this unit is going out"; "Dispatch anyway" records your reason on the defect, "Keep it off the road" stops.
- If the load saved but the RC did not: "Load L-… created, but RC upload failed." Use "Retry attachment" (it never books a second load) or "Open the load without it".

Why it won't work
- "The rate confirmation is required to create a load." — no RC chosen. Add the file.
- "Broker is required" / "Customer Reference # is required" — fill them.
- "The rate confirmation is over 10 MB." — use a smaller file.
- See "Why a load cannot be created or saved" for every field message.

## Fill a load from the rate confirmation (RC reader)

Path: Operations › Loads (/loads) › "New load" › "Rate confirmation (RC)" area · Permission: loads.create

Choosing a PDF or image RC on the Add load form sends it to the RC reader, which proposes values. Nothing is saved by reading; you check every field and create the load as usual.

Steps:
1. Drop or browse the RC. "Reading the RC… the form fills itself when it is done." shows while it works.
2. When done: "Filled from the RC — check every field before you create the load."
3. What it fills: the broker (matched by MC number first, then name), "Customer Reference #" (the broker's load number), commodity, weight (only 100–80,000 lb), rate (total, else linehaul), equipment, hazmat, the first pickup and last delivery (facility, street, city, state, ZIP, appointment), stops in between (up to 6), and notes (temperature and stop reference numbers).
4. Read the yellow warnings, e.g. "No appointment time for … - type it in.", "No pickup found on the RC.", "No delivery found on the RC.", "The RC gives the weight as … lb - type the real weight.", "The RC asks for equipment other than a van, reefer or flatbed."
5. If the broker is not in your list: "Broker "…" (MC …) is not in the broker list." — click "Add this broker".
6. A "Message for the driver" card appears with a Telegram text built from the RC. Edit it, then "Copy" or "Telegram". Add what the RC does not say (trailer, live / drop).

Why it won't work
- "The file is empty" / "The file is too large" (the reader takes up to 20 MB) — choose another file. Creating the load still needs the RC to be 10 MB or less.
- "This broker's RC is not known yet" — fill the form by hand; send the RC so the reader learns this broker.
- "This RC is a scan or a photo" — the reader only reads PDFs with text in this setup; fill by hand.
- "The RC reader did not answer" — click "Read again" or fill by hand.
- "The RC reader is busy" — try again in a minute.
- "The RC reader is not set up" / "The RC reader is not available" — server-side problem; fill by hand and tell an administrator.
- "This file could not be read" / "This RC could not be read" — try a clearer copy or fill by hand.
- A file type other than PDF, PNG, JPEG or WEBP is not read at all; fill by hand.

## Stops, extra stops and appointment time zones

Path: Operations › Loads (/loads) › "New load" or row "Edit" › "Stops" · Permission: loads.create (new) / loads.edit (edit)

A load always has one first Pickup and one final Delivery; up to 6 stops can sit between them.

Steps:
1. Fill stop 1 "Pickup" and the last "Delivery": "Facility" (shipper or receiver name), "Street", "City", "State" (two letters), "ZIP", "Appointment" (date and time).
2. To add a stop, click "Add stop". The delivery you already typed becomes a middle stop and a fresh final Delivery card opens at the end.
3. For a middle stop pick "Pickup" or "Delivery" in its kind selector.
4. To take off the last added stop, click the "×" ("Remove stop N") on the final Delivery card; the stop before it becomes the delivery again.
5. Each appointment is typed in the stop's own local time. "Time zone:" beside the field shows the zone found from ZIP, or city and state. Amber "zone unknown" means no zone was found — check the spelling or add a ZIP.

What happens after: times are saved in each stop's own zone and shown with the Eastern time beside them on the load page.

When editing, if a stop changes city after an arrival or departure was recorded there, a window "Clear recorded times at these stops?" lists them. "Clear times and save" clears those times (written to the timeline); "Keep the times" goes back.

Why it won't work
- "Origin city is required", "Destination city is required", "City is required" — fill the city.
- "Use the two-letter state code" — e.g. TX, not Texas.
- "ZIP is five digits" — 5 digits or ZIP+4.
- "Pickup appointment is required", "Delivery appointment is required", "Appointment is required".
- "Delivery must be after pickup" — the final delivery appointment is earlier than the pickup.
- "Add stop" is missing — the load already has 6 extra stops.
- Recording events later fails with "… has no time zone. Add the city and state on the stop, and the zone follows." — fix the stop's city/state.

## Add a broker that is not in the list while booking

Path: Operations › Loads (/loads) › "New load" › "Broker" field · Permission: loads.create (and permission to create brokers)

Steps:
1. In "Broker", type the name. If nothing matches, click "+ Create broker "…"". (After the RC reader, the button is "Add this broker".)
2. The "New broker" window opens: "Broker name" and "MC number" are required ("MC-123456, or just the digits."). "Phone", "Email", "Billing address", "City", "State", "ZIP" and "Billing email" are optional.
3. Click "Create and select".

What happens after: toast "… added — Selected on this load. Payment terms default to Net 30 on their record." The broker is chosen on the load. Complete the rest on the broker's record later (Operations › Brokers).

Why it won't work
- "Create and select" is greyed out — broker name or MC number is empty.
- "Not created" with a message — the server refused (e.g. a duplicate or no permission). Read the message; ask an administrator if it is a permission.
- A broker marked do-not-use never appears in the Broker list on a load.

## Why a load cannot be created or saved

Path: Operations › Loads (/loads) › "New load" or row "Edit" · Permission: loads.create (new) / loads.edit (edit)

Messages on the form and what to do:
- "The rate confirmation is required to create a load." — attach the RC in "Rate confirmation (RC)".
- "Broker is required" / "Customer Reference # is required" — required on new loads.
- "Rate is required" — enter a rate of at least $1.
- "Loaded miles are required" — enter miles (at least 1), or click "Use N mi".
- "Gross weight cannot exceed 80,000 lb" — fix the weight, or leave it blank.
- "Use the two-letter state code", "ZIP is five digits", "… is required", "Delivery must be after pickup" — stop fields, see "Stops, extra stops and appointment time zones".
- "That load number is too long" — the number is generated; this only appears with an unusual number.
- "Load L-… already exists." — another load took that number; close the form and try again.
- "The rate confirmation is over 10 MB." — use a smaller file.
- "Load L-… created, but RC upload failed." — the load exists. Click "Retry attachment", never book it again.
- "Unit … is out of service" window — an open out-of-service defect holds the truck. Pick another truck, or give a reason and "Dispatch anyway".
- "L-… changed since you opened it. Reload the load and try again." — someone else saved first. Close, reopen and redo your change.
- "L-… is invoiced (INV-…). Ask Accounting for a correction; notes can still be added." — once invoiced, only someone with accounting.edit may edit, reassign, cancel or replace documents.
- "… cannot be changed through Edit. Status moves on the Daily Board or Record an event; the assignment has its own route." — status cannot be edited in the form.
- A 403 / not-allowed message — you lack loads.create or loads.edit.

## Edit a load

Path: Operations › Loads (/loads) › row "⋯" › "Edit" (opens "Edit L-…") · Permission: loads.edit

Booking and editing are the same form, so any field set at booking can be corrected.

Steps:
1. On Loads, open the row menu "⋯" and click "Edit".
2. Change broker, "Customer Reference #", equipment, hazmat, stops, rate, miles, weight, driver, co-driver, truck, trailer.
3. "Status" is read-only here: it "Moves from the Daily Board or the load page's Record an event, not here."
4. "Dispatcher" shows the one recorded on the load; click "Reassign" to choose another (recorded on the timeline).
5. On an existing load, miles are not recalculated by themselves: "Use N mi" offers the route's figure.
6. Click "Save changes".

What happens after: a changed driver, truck or trailer is saved first through the assignment rules (and the out-of-service check), then the other fields. Toast "Load L-… saved".

Why it won't work
- "L-… is invoiced (…). Ask Accounting for a correction; notes can still be added." — needs accounting.edit.
- "L-… is cancelled; its assignment cannot change." (also completed or TONU) — cannot reassign.
- "A delivered load keeps the driver who ran it." — you cannot clear the driver on a delivered load.
- "L-… changed since you opened it. Reload the load and try again." — reopen and redo.
- "Clear recorded times at these stops?" — a stop with recorded times changed city; confirm or keep the times.
- For other field messages see "Why a load cannot be created or saved".

## Load detail page: what each part shows

Path: Operations › Loads (/loads) › click a load (/loads/L-…) · Permission: loads.view
Needs to change: loads.edit

The page refreshes every 15 seconds so changes from the Daily Board appear.

Parts of the page:
1. Header: "Load L-…", status badge, paperwork chip (e.g. "POD missing"), "Updated … ago". Buttons: "Add note", "⋯" ("Flag load", "Cancel load") and "Record an event".
2. Open flags in amber with "Close flag".
3. One fact line: customer, "via" broker (or "direct, no broker"), reference, route, miles, equipment, weight, rate.
4. An invoiced load shows a blue note that billed facts belong to Accounting now.
5. "Next" bar: what must happen next ("Assign a driver and truck", "Dispatch …", "Record departure from … with the BOL", "Record arrival at …", "Record departure and upload the POD", "Review the PODs and bill"), its owner, when it is due (stop time, Eastern, Tashkent), "Then …", and the button that does it. It turns red "Late" when overdue. "Add check call" shows while the load is rolling.
6. Journey bar: Booked, Assigned, Dispatched, At pickup, Loaded, In transit, one step per delivery, Delivered, Billing. A cancelled load shows "CANCELLED".
7. Tabs: "Overview", "Tracking", "Documents", "Financial", "Notes".

Overview tab panels:
- "Route": each stop with window (stop time, Eastern, Tashkent), "Arrived", "On site", "Free time", "Loaded", "Departed", "Detention". Buttons: "Record arrival" (deliveries), "Record departure", "Confirm appt" (deliveries not yet arrived).
- "Activity": check calls, stop events, documents and notes newest first, with filters "All", "Check calls", "Stop events", "Documents", "Notes".
- "People and equipment": Driver (with "Assign" when unassigned), Truck, Trailer, Dispatcher, Updater, "Owner now" (dispatcher until the truck leaves the pickup, then the updater).
- "Instructions": pinned notes plus commodity, pieces, weight, equipment.
- "Paperwork": rate confirmation, bill of lading, POD per delivery, lumper receipts, each marked due, later or done.
- "Money and billing": rate, per-mile figures, detention, bill-to and the billing checklist.

Tracking tab: last known truck position and arrival/departure/ETA events (the live map is on Operations › Tracking).

Why it won't work
- "Load not found" — no load with that number; use "Back to loads".
- "Unable to load this load" — click retry.
- Buttons refuse with a permission message — you need loads.edit.

## Assign a driver, truck and trailer to a load

Path: Operations › Loads › load page (/loads/L-…) › "People and equipment" › "Assign" beside "Unassigned" · Permission: loads.edit
(Also: row "⋯" › "Edit" on the Loads list, or the "Driver" field when booking.)

Steps (from the load page):
1. On the Overview tab find "People and equipment". Next to Driver "Unassigned" click "Assign".
2. In "Assign L-…" pick the "Driver" (required). Their current unit fills "Truck" and "Trailer"; change them if needed.
3. Click "Assign".

What happens after:
- Toast "L-… assigned". The timeline says "Assigned to …".
- A Booked load that now has a driver and a truck becomes Assigned by itself. Assigning never dispatches; dispatching is done on the Daily Board.
- The driver's Daily Board row shows DISPATCHED when this is the driver's current load.

The "Assign" button only shows when you have loads.edit, the load has no driver, is not invoiced, and is not delivered, completed or cancelled. To change an existing driver, use "Edit" on the Loads list.

Why it won't work
- "Not assigned — Unit … is out of service … Use Edit load to dispatch it with an override." — the truck has an open out-of-service defect. Use "Edit" from the Loads list row menu, which offers "Dispatch anyway" with a reason, or choose another truck.
- "Assign" is greyed out — no driver chosen.
- "L-… is invoiced (…). Ask Accounting for a correction; notes can still be added." — needs accounting.edit.
- "L-… is cancelled; its assignment cannot change." — also for completed and TONU loads.
- "A delivered load keeps the driver who ran it."
- "L-… changed since you opened it. Reload the load and try again." — refresh and retry.

## Record an event: arrival, departure, loaded (BOL), POD, check call, ETA

Path: Operations › Loads › load page (/loads/L-…) › "Record an event" (or "Record arrival" / "Record departure" on a stop, or the Next bar button) · Permission: loads.edit

You say what happened, at which stop and when; the status follows. Times are typed in the stop's own time zone, with the Eastern time shown under the field.

Steps:
1. Click "Record an event".
2. "What happened": "Arrived at PU" / "Arrived at delivery", "Loaded (BOL)", "Departed a stop", "Check call", "ETA changed".
3. "Stop": pick the stop (for check call / ETA it is "Next stop").
4. "Date (zone)" and "Time (zone)": prefilled with now in the stop's clock; correct it to when it really happened.
5. Extra fields:
   - "Loaded (BOL)": optional "Pieces" and "Weight (lbs)", and the "Bill of lading (BOL) *" file — required.
   - "Departed a stop" at a pickup: attach the BOL for that pickup — required.
   - "Departed a stop" at a delivery: attach the "Proof of delivery (POD) *" — required.
   - "Check call" / "ETA changed": "Where the truck is"; ETA also needs "New ETA date" and "New ETA time".
6. Optional "Note". Click "Record".

What happens after (toast shows the new status):
- Arrived at a pickup → At pickup. Arrived at a delivery → At delivery.
- Loaded (BOL) → Loaded; the pickup stays open (detention keeps running) until departure.
- Departed a pickup → In transit.
- Departed a delivery that is not the last → back to In transit to the next stop.
- Departed the last delivery → Delivered (the POD is filed with it).
- Check call / ETA: nothing moves; the update clock resets and an ETA you type stands in for the projected one.
- If the truck stayed past free time (default 2 hours from the later of arrival and appointment), a detention charge is drafted (default $50/hour) for billing to decide.
- The driver's Daily Board row follows (AT PU, ENROUTE, UNLOADING, READY) unless the driver is HOME, SHOP or similar.

Why it won't work
- "Record" greyed out — no stop picked, no time, or the BOL/POD file is not attached; "Loaded" also needs a pickup stop.
- "Attach the BOL before the truck leaves the pickup." / "Attach the POD before the truck leaves the delivery." — add the file.
- "The BOL is over 10 MB." (or POD) — smaller file.
- "That time is in the future." — more than 5 minutes ahead of now.
- "A departure cannot be before the arrival." — fix the time.
- "That time does not parse." — re-enter date and time.
- "… has no time zone. Add the city and state on the stop, and the zone follows." — edit the stop.
- "That time was entered in …; … runs on …. Confirm the zone before saving." — reopen the dialog for that stop.
- "L-… is cancelled; its stops do not move." (also TONU, completed).
- "A BOL belongs to a pickup." / "Loaded belongs to a pickup." — pick a pickup.
- "L-… is delivered; there is nothing left to check on." — no check calls after delivery.
- "Say what the new ETA is." — fill the ETA.
- "L-… changed since you opened it. Reload the load and try again."

## Load statuses and how a load moves from one to the next

Path: Operations › Loads › load page (/loads/L-…) · Permission: loads.view (moves need loads.edit)

Statuses in order: Booked → Assigned → Dispatched → At pickup → Loading → Loaded → In transit → At delivery → Unloading → Delivered → Completed. Side exits: Cancelled and TONU (truck ordered, not used).

What moves each one:
- Booked: created with no driver.
- Assigned: a driver and a truck put on a Booked load (automatic).
- Dispatched: set on the Daily Board (DISPATCHED), or straight away when a driver is chosen at booking.
- At pickup: arrival recorded at a pickup.
- Loaded: "Loaded (BOL)" recorded, or the BOL confirmed from the Paperwork window.
- In transit: departure from the pickup (never the BOL alone), or departure from a non-final delivery.
- At delivery: arrival at a delivery.
- Delivered: departure from the last delivery (the POD is attached), or the POD confirmed from Paperwork. A status move to Delivered is refused until every delivery stop is complete.
- Completed: the final state after Delivered (shown as "Completed" everywhere).

Allowed direct status moves (Daily Board / status changes):
- Booked → Assigned, Cancelled, TONU
- Assigned → Dispatched, back to Booked, Cancelled
- Dispatched → At pickup, back to Assigned, Cancelled, TONU
- At pickup → Loading, Loaded, TONU
- Loading → Loaded; Loaded → In transit
- In transit → At delivery, Unloading, Delivered
- At delivery / Unloading → Unloading, Delivered, or In transit (more deliveries left)
- Delivered → Completed. Completed, Cancelled and TONU are final.

Paperwork needed to stand at a status: Assigned through Loading need the rate confirmation; Loaded through Unloading need the RC and the bill of lading. Delivered does not wait for the POD, but a missing POD shows a chip and blocks billing.

Every move is written on the load's timeline with who made it and from where (Daily Board, BOL upload, POD upload).

Why it won't work: see "Why a load status change is refused".

## Why a load status change is refused

Path: Operations › Loads › load page (/loads/L-…) or Dispatch board · Permission: loads.edit

The server checks every status move. Messages and fixes:
- "L-… is already <status>." — nothing to do.
- "L-… cannot go from <status> to <status>." — that jump is not allowed; record the missing events in order (see "Load statuses and how a load moves from one to the next").
- "A load needs a driver and a truck before it is dispatched." — assign both first (Assign on the load page or Edit).
- "No delivery has been completed yet. Finish the stop, and the load follows." — record the departure at the delivery instead of setting Delivered.
- "N delivery stop(s) still open: …" — finish those stops first.
- "<status> needs the rate confirmation." / "… needs the bill of lading." — upload the paperwork in Documents, then retry.
- "Moving a load without its paperwork takes a dispatch lead." — only a dispatch lead (dispatch.manage) may bypass missing paperwork.
- "Say why the paperwork is not there." — a lead bypassing paperwork must give a reason.
- "L-… changed since you opened it. Reload the load and try again." — someone saved first; reload.
- "L-… is invoiced (…). Ask Accounting for a correction; notes can still be added." — assignment, edits, cancel and document replacement are locked after invoicing unless you have accounting.edit.
- Corrections of recorded times: "Taking a delivered load backwards takes a dispatch lead.", "That entry was made by …; correcting it takes a dispatch lead.", "That was recorded more than 2 h ago; correcting it now takes a dispatch lead.", "Say why this is being corrected".

## Flag a load and close a flag

Path: Operations › Loads › load page (/loads/L-…) › "⋯" › "Flag load" · Permission: loads.edit (seeing flags: loads.view)

A flag says "this load needs a person". It never changes the status and never blocks dispatch writes, but it keeps the load in front of everybody (Loads "Flagged" view, red "Flagged" tag, the Daily Board and Notifications) until closed. An open flag holds billing: the load leaves "Ready to bill" and billing shows "An open flag says this load needs a person first."

Steps to flag:
1. On the load page click "⋯" then "Flag load".
2. "What kind of problem": "Running late", "Breakdown", "Paperwork", "Broker issue", "Driver issue", "Damage or claim", "Other".
3. "What is wrong": one or two sentences somebody else can act on.
4. Click "Flag load". Toast "L-… flagged".

Steps to close:
1. On the load page, the amber flag bar shows the kind, note, who opened it and when. Click "Close flag".
2. Type "What was done" and click "Close flag" ("Keep open" leaves it).

Why it won't work
- "Flag load" / "Close flag" greyed out — the note needs at least 3 characters ("Say what the problem is" / "Say what was done").
- "That load is not in this company." — wrong company; switch company.
- "That flag is not on this load." — refresh the page.
- "That flag was already closed by …" — someone closed it first.
- Permission refusal — flagging and closing need loads.edit.

## Cancel a load or mark it TONU

Path: Operations › Loads › load page (/loads/L-…) › "⋯" › "Cancel load" · Permission: loads.edit (after dispatch also dispatch.manage)

Steps:
1. Click "⋯" then "Cancel load" (it reads "Cancel load (lead only)" when a lead is needed and you are not one).
2. "Outcome": "Cancelled" (nothing is billed) or "TONU - truck ordered, not used" (the broker owes a fee).
3. For TONU enter "TONU fee" — required; $0 is allowed, blank is not.
4. "Requested by": the broker, the customer, or us.
5. "Broker approval": the name at the broker who agreed, how ("Email", "Phone", "Other") and a reference (email subject, ticket or call note).
6. "Reason" (at least 3 characters).
7. Click "Cancel load" or "Mark TONU". "Keep load" closes without changes.

Who may cancel:
- Booked or Assigned: the load's dispatcher or updater, or a dispatch lead (dispatch.manage).
- Dispatched or At pickup: only a dispatch lead.
- Loading or later: nobody — a load past the pickup is delivered or claimed, not cancelled (the menu item is hidden).

What happens after: driver, truck and trailer are released; the timeline says "Cancelled" or "TONU - $… fee". A TONU keeps one billable TONU charge; billing needs the broker's TONU confirmation or a revised RC on file. No notice is sent — tell the broker yourself. It cannot be undone.

Why it won't work
- "Cancel load" greyed out — reason, requested by, broker approval name or TONU fee missing.
- "L-… is already dispatched. Only a dispatch lead can cancel it now - ask one." / "… Ask a dispatch lead to cancel it."
- "L-… is <status>; a load past the pickup is delivered or claimed, not cancelled."
- "Only L-…'s dispatcher or updater, or an administrator, may cancel it."
- "A TONU needs the fee the broker agreed to, even if it is $0."
- "L-… is invoiced (…). Ask Accounting for a correction; notes can still be added."
- "L-… changed since you opened it. Reload the load and try again."

## Recover a load (hand it to another driver mid-run)

Path: Operations › Loads (/loads) › row "⋯" › "Recover load" · Permission: loads.edit

Use it when a truck breaks down or a driver runs out of hours and someone else finishes the run. The linehaul is split by miles between the two drivers.

Steps:
1. On the Loads list open the row menu "⋯" and click "Recover load".
2. "Takes it over": the driver finishing the run, or "Nobody yet — put it back on the board".
3. "On truck": the new unit, or "No truck".
4. "Miles completed": how far the first driver got (prefilled from tracking; between 0 and the loaded miles).
5. "What happened" (required): e.g. the breakdown and where.
6. Check "Pay split": each driver's loaded miles and linehaul share.
7. Click "Recover and split pay".

What happens after: the timeline says "Recovered from … (unit …)" with the split. Both shares land on the two drivers' settlements as drafts for accounting to approve. If the new truck is out of service you are asked for a reason ("Dispatch anyway").

Why it won't work
- "Recover and split pay" greyed out — "What happened" under 3 characters, or miles outside 0 to loaded miles ("Enter a number between 0 and …").
- "A delivered load cannot be recovered" — also completed loads.
- "That driver already has this load" — pick a different driver.
- "Driver not found" / "Truck not found" — refresh and pick again.

## Load documents: attach, review, verify and replace (RC, BOL, POD)

Path: Operations › Loads › load page (/loads/L-…) › "Documents" tab; or Loads list row "⋯" › "Attach files" / "Paperwork" · Permission: loads.view (uploading and reviewing: loads.edit)

Every load always lists the three that matter: Rate confirmation, BOL and POD (one per delivery), then anything else (detention, TONU, layover, invoice, lumper receipt, other).

Attach files (several at once):
1. Click "Add document" (Documents tab), "Upload" on a missing row, row menu "Attach files", or use the "Attach files" area in "Paperwork".
2. Drop files or "browse" (PDF, JPG, PNG; up to 10 MB each).
3. For each file set "Document type" (guessed from the file name) and "Title". Optional "Notes (optional)".
4. Click "Upload N files". Each lands as "Received". Toast "N files filed on L-… — Received. Review is a separate action."

Duplicates: the same file under a second type shows "Same file, second type" with "This is the same file already filed as the …" or "A file with this name is already filed as the …". Click "Upload anyway" if it is right.

Paperwork window (row menu "Paperwork"): shows "N of 3 uploaded", "N documents missing: …", the Attach files area and "On this load". In this window, filing a BOL or POD asks "Mark loaded at …?" or "Delivered at …?" — "Yes, mark loaded" / "Yes, delivered" completes only that stop; "Not now" leaves the load as it is. Filing never moves the load by itself.

Review states: "Received" (with "Needs review" on the Documents tab), "Reviewed", "Verified". In Paperwork use the eye icon "Mark … reviewed", the check icon "Verify …", and "Replace …". "View" opens the file in the viewer; paper previews stay light in dark mode. A replacement starts unreviewed and the old file stops counting.

Due dates on the Documents tab: a missing BOL reads "Not yet due" until the truck reaches the pickup; a POD until it reaches a delivery.

Why it won't work
- "… is over 10 MB" / "The file is over 10 MB." — smaller file.
- "Failed - retry" — the upload failed; click Upload again.
- "No file on record for this document" — old seeded paperwork has no file; upload one.
- "Already reviewed." / "Already verified." — nothing to do.
- "A document cannot go back to received."
- "This file has been replaced. Review the replacement instead."
- "This file was rejected. Upload a replacement; the replacement is reviewed on its own."
- "L-… is invoiced (…). Ask Accounting for a correction; notes can still be added." — after invoicing only accounting.edit may file documents.
- "L-… is delivered; nothing to confirm." — the suggestion came too late; the load already moved.

## Billing readiness, money and detention drafts on a load

Path: Operations › Loads › load page (/loads/L-…) › "Money and billing" panel and "Financial" tab · Permission: loads.view

Money and billing panel: "Rate (all-in)", "Per mile · all-in / loaded", detention lines ("… draft", "Running since …", "Draft charge if it starts at …"), "Bill to", and "Billing: ready" or "not ready" with three checks:
- "Rate confirmation on file"
- every delivery recorded and every POD reviewed (or verified)
- "Accessorial charges decided" (else "N accessorial drafts to decide")
When all three pass and there is no invoice, a "Ready to bill" link opens the Loads "Ready to bill" view.

Paperwork chip: a delivered load missing paper shows e.g. "POD missing" or "rate confirmation and POD missing" beside its status. The freight is delivered, but the load cannot be invoiced until the paper is filed.

Loads "Ready to bill" view: Delivered, POD on file, no invoice, no open flag.

Financial tab: "Profit and loss" (revenue, cost lines, gross profit, RPM, CPM, PPM) once costs post; before that "No costs booked yet". "Charges": line items with "Billable"/"Not billable" and "Payable to driver"/"Company", and the total.

Detention drafts: when a departure is recorded after free time ran out (default 120 minutes from the later of arrival and appointment), a detention charge is drafted at the default $50 per hour: "Detention at … · N min past N min free". Drafts are not billed. A corrected departure re-drafts it. The load page shows the draft but has no accept/drop button of its own.

Why it won't work (billing conditions)
- "The load is not delivered yet." — finish the deliveries.
- "N of N proofs of delivery on file." — upload the missing PODs.
- "RC rejected: …. Upload a replacement." (also BOL, POD) — replace the file.
- "An open flag says this load needs a person first." — close the flag.
- "N drafted accessorial(s) to accept or drop." — the detention/accessorial drafts must be decided before billing.
- "Cancelled without a fee: nothing to bill."
- TONU: "A TONU needs the broker's TONU confirmation or a revised rate confirmation on file." / "The TONU fee is not recorded."

## Notes, pinned instructions and check calls on a load

Path: Operations › Loads › load page (/loads/L-…) › "Notes" tab, "Add note" button, or "Activity" panel · Permission: loads.edit

Steps (Notes tab):
1. Click "Add note" in the header (opens the Notes tab).
2. Type in "Note" ("Internal by default; brokers and drivers do not see it.").
3. Tick "Pin to the top" for what the next shift must know first.
4. Click "Add note". Toast "Note added" or "Note pinned".
5. Pin or unpin any note with the pin icon.

Steps (Activity panel on Overview):
1. Choose "Check call" or "Note".
2. Check call: type where the truck is and what is happening, then "Add" (or Enter). It resets the update clock; nothing moves. Only while the load is live.
3. Note: choose "Visible to" "Internal", "Customer" or "Driver", optionally "Pin for the next shift", then "Add".

Pinned notes show in "Instructions". A pinned note like "confirm 24 hours ahead" makes the Route panel show "Confirm by" for deliveries; "Confirm appt" records that the receiver confirmed (written as a note).

Why it won't work
- "Note not saved" / "Could not add it." with a message — read it; "L-… changed since you opened it. Reload the load and try again." means reload.
- "Check call" is greyed out — the load is delivered, completed, cancelled or TONU.
- "That note is no longer on the load." — refresh.
- Notes stay open after invoicing; everything else is locked.

## Tracking page: live map of trucks and loads

Path: Operations › Tracking (/tracking) · Permission: dispatch.view

The live map of every truck with a position, and a side panel of unit cards.

Steps:
1. Open Operations › Tracking. The map fills the page; "Refresh" on the map reloads positions. The map options button switches the base map (default, terrain, satellite) and overlays (weather, labels, roads).
2. In the side panel use "Search unit · driver · load…" (unit, driver, load number, customer, city).
3. Filter by "All statuses" / "Rolling" / "Idle" / "Stopped" and "All loads" / "With a load" / "No load".
4. "Show units": "All units", "Active loads", "Trucks moving", "Trucks stopped", "At risk", "Tracking stale", "Available trucks", "Delivered today" — each with a count.
5. The line under it counts "Rolling", "Idle", "Stopped" and "… without a position".
6. Each card shows unit, driver ("No driver"), the load number or "Unassigned", "Speed", "Location", and "fix Nh old" when the position is old.
7. Click a card or a map marker to open the unit panel: "Status" (Availability, Tracking, Last position, Last update, Speed and any blocker), "Active load" (load, status, lane, risk), "ETA" (Scheduled, Current, Variance in minutes, risk reasons), "Related" (customer, broker, driver). Buttons "Open unit", "Maintenance", "Open load"; "Close" returns to the list.

Rolling = 5 mph or more on the last fix; Idle = engine on or idling; Stopped = otherwise, or no tracking.

Why it won't work
- "Tracking could not be loaded" — click retry.
- "No units match" — clear the filters or widen the search.
- A truck is missing from the map — it has no position ("… without a position"); check its telematics.
- "Insufficient data" under Variance — the load needs both a scheduled delivery and a current ETA.
- Only the first 80 cards are listed: "… more — narrow the search to see them."
- The page is not in your menu — you need dispatch.view.
