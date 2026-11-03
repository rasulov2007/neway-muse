# Dispatch boards

The Dispatch board is where dispatchers run their drivers day by day and week by week, the way they used to in the company Google Sheet. One sidebar link, "Dispatch board" (under Operations), opens the Daily Board; the tabs across the top of every board page switch between Daily Board, Weekly Board, Performance, Weekly Report, Commission, Salary Report, Detention & Layover, Match rows to drivers, On vacation and Dispatcher rotation. Each tab shows only when your account holds its permission. Everything typed on a board is saved to the server straight away and seen by everyone.

## Dispatch board tabs and who can open them

Path: Operations › Dispatch board (/dispatch/daily) · Permission: any of dispatch.view, board_daily.view, board_weekly.view, board_performance.view, board_claims.view, dispatch_pay.view

The sidebar has one "Dispatch board" link. The pages are switched with the tab strip at the top of the board. A tab you cannot open is simply not shown.

Tabs and what they need:
1. "Daily Board" (/dispatch/daily) – dispatch.view or board_daily.view.
2. "Weekly Board" (/dispatch/weekly) – dispatch.view or board_weekly.view.
3. "Performance" (/dispatch/performance) – dispatch.view or board_performance.view.
4. "Weekly Report" (/dispatch/weekly/report) – dispatch_pay.view.
5. "Commission" (/dispatch/commission) – dispatch_pay.view.
6. "Salary Report" (/dispatch/salary) – dispatch_pay.view.
7. "Detention & Layover" (/dispatch/claims) – dispatch.view or board_claims.view.
8. "Match rows to drivers" (/dispatch/roster-match) – dispatch.manage.
9. "On vacation" (/dispatch/vacations) – dispatch.view or drivers.view.
10. "Dispatcher rotation" (/dispatch/rotation) – dispatch.manage.

The pill beside the tabs tells you what you can do on the page:
- "Admin" – you hold dispatch.manage (add/import/edit drivers, edit claims, manual commission dialogs).
- "Editing" – you hold dispatch.edit and can type on the boards.
- "View only" – you can read but not type.

The three pay pages (Weekly Report, Commission, Salary Report) are about what dispatchers earn and are meant for the company administrator. The old address /dispatch now just forwards to the Loads page.

Why it won't work
- A tab is missing: your role does not hold the permission listed above. Ask an administrator to grant it.
- Cells will not open for typing and the pill says "View only": you do not hold dispatch.edit.

## Daily Board: what the columns and statuses mean

Path: Operations › Dispatch board › Daily Board (/dispatch/daily) · Permission: dispatch.view or board_daily.view
Needs to change: dispatch.edit (typing, status, Fill); dispatch.manage (Add driver, Import roster, Edit driver)

The Daily Board shows every driver on one row, grouped by dispatcher team ("Team 1", "Team 2"…) with drivers without a team at the bottom under "Unassigned drivers". Inside a team rows are ordered by status.

Columns: "Load #", "Driver name", "Truck #", "Trailer #", "Phone #", "Status", "Active since", "ETA", "Miles", "Origin / Delivery", "Notes".
- "Load #" is the load assigned to the driver and opens it; it can never be typed. A red flag badge (⚑ and a number) means open flags on that load; "Update due" means the load has not been heard from in its update cadence.
- "Driver name" is read-only. A red "Hold" badge means a CDL/medical hold (hover to see why). A co-driver shows after "//"; the grey chip is the pay tag.
- "Active since" counts how long the current status has been set; amber after 1 hour, red after 1 day.
- "Notes" can show "late" (ENROUTE past the delivery time), "<load> still assigned" (driver marked off but still has a load), and blue badges for prebooked (queued) loads.

Status words (the palette): RE-UPDATE, DISPATCHED, AT PU, COVERED, RESERVED, HOLD FOR LOAD, READY, ENROUTE, UNLOADING, NO ANSWER, STOP, REST, NEW DRIVER, HOME, VACATION, SHOP. The words marked "off" in the menu (NO ANSWER, STOP, NEW DRIVER, HOME, VACATION, SHOP) mean the driver is not available.

Status and truck, along with load, trailer, phone, ETA, route and notes, carry into the next day; Miles does not.

Top bar controls: day picker (last six weeks, "Previous day"/"Next day"), "Today", the view switch "Teams" / "Board T", "Fill", "Add driver", "Import roster", Refresh, and the search box "Search driver, unit, load or note…". "Board T" is a flat list with a status filter ("Show all" plus one chip per status with its count) and a "Back to Daily Board" button.

Why it won't work
- "No drivers on the board yet." – the roster is empty; an administrator adds drivers with "Add driver" or "Import roster".
- "No drivers match." – clear the search box or the Board T status filter.

## Edit cells on the Daily or Weekly Board

Path: Operations › Dispatch board › Daily Board (/dispatch/daily) or Weekly Board (/dispatch/weekly) · Permission: dispatch.view (or board_daily.view / board_weekly.view)
Needs to change: dispatch.edit

Both boards work like Google Sheets.

Steps
1. Click a cell once to select it. Click it again, press Enter or F2, or just start typing to edit.
2. Enter saves and moves down; Tab saves and moves right (Shift+Tab left); Esc cancels.
3. Shift+arrows, Shift+click or dragging selects a range; clicking a column header selects the column; Ctrl+A selects everything.
4. Ctrl+C copies, Ctrl+V pastes a block from the selected cell. One value pasted over a selected range fills the whole range.
5. Delete clears the selected cells; an "Undo" bar appears for a few seconds. Ctrl+Z undoes (last 50 edits), Ctrl+Y or Ctrl+Shift+Z redoes.
6. To colour cells, select them and pick a colour from "Fill" (ten tints or "No fill"). The Status cell cannot be painted.
7. Right-click a driver's name or status to see "Edit history — <driver>" (who changed what and when).

Formulas: a cell starting with "=" is worked out, e.g. =2150+1350. Only numbers, + − * / and brackets are allowed.

The top bar shows "Saving…", "Saved" or "Save failed". Hover "Save failed" to read why.

What cannot be typed: "Load #", "Driver name", "Active since" and "Status" (status is chosen from its menu). Delete never clears Status or Truck #.

Why it won't work
- "LOAD # is the load assigned to the driver and cannot be typed or cleared. Assign or release the load instead." – assign or release the load on the Loads page.
- "Conflict · reload to see the newer value" (or "<column> on <day> was changed by <name> at <time>. Reload before writing again.") – someone else changed the same cell. Press Refresh and type again.
- "\"…\" is not a mileage (a number, \"1,250 mi\" or =600+650; never negative)" – Miles takes only a number or formula.
- "\"…\" is not a formula the board can work out" – fix the formula after "=".
- "\"…\" is not a status on the palette" – only the listed status words are allowed.
- Paste notice "N pasted · X landed on read-only or calculated cells and were skipped" or "fell outside the grid and were not pasted" – part of the block hit locked columns or the edge of the board.
- "Writing the board takes dispatch.edit" / "Painting the board takes dispatch.edit" – you need dispatch.edit.
- "Fill" is greyed out – you have no dispatch.edit, or no cell is selected.

## Set a driver's status on the Daily Board

Path: Operations › Dispatch board › Daily Board (/dispatch/daily) › Status column · Permission: dispatch.view or board_daily.view
Needs to change: dispatch.edit

Steps
1. Click the "Status" cell of the driver; the status menu opens (a second click does not close it).
2. Pick a word. Plain words (COVERED, RESERVED, HOLD FOR LOAD, RE-UPDATE, REST, HOME, SHOP, NO ANSWER, STOP, NEW DRIVER, VACATION, READY with nothing to finish) are saved at once.
3. DISPATCHED, AT PU, ENROUTE, UNLOADING, and READY after a delivery, open a side panel beside the board because they also move the load:
   - "Dispatch this load" (DISPATCHED): answer "Where is the truck?" – "Going to PU" or "AT PU" – and attach the "Rate confirmation" if it is not already on file.
   - "Left the shipper" (ENROUTE from the pickup): enter "Departed" date and time, and the "Bill of lading" if the load is not yet loaded.
   - "On the dock" (UNLOADING): enter "Checked in" date and time.
   - "Finish the delivery" / "Finish this stop, N to go" (ENROUTE off a delivery, or READY): enter "Checked out" date and time and attach the "Proof of delivery".
   - Times are in the stop's own time zone. Add an optional "Note", then "Save". "Cancel" changes nothing. "Open the full load" opens the load page.
4. After saving, the toast says "The load and the board moved together."

Assigning a load to a driver whose Load # is empty fills Load # and turns the row DISPATCHED by itself. Setting VACATION puts a driver who has a driver file on vacation from that day; a later on-duty word records the return.

Why it won't work
- "<driver> has no load" – "Assign a load first; the row turns DISPATCHED by itself. Until then it stays READY." DISPATCHED, AT PU, ENROUTE and UNLOADING need a load on the driver.
- "<driver> has no load assigned, so the row cannot read <word>. Assign a load on the Loads page; the row turns DISPATCHED by itself." – same rule, from the server.
- "This stop has no time zone. Add its city and state on the load first." – fix the stop on the load page.
- "Give the date and the time." – fill both inputs.
- "Save" stays grey: the date/time is missing or the required paper (BOL, POD or rate confirmation) has not been attached.
- "That load could not be read. Nothing has been changed." – refresh and try again.
- "<load> needs nothing here: READY says the truck is empty and free." – nothing to finish; press "Set READY".
- The status menu does not open: you do not hold dispatch.edit.

## Add a driver to the board or move a driver to another team

Path: Operations › Dispatch board › Daily Board (/dispatch/daily) or Weekly Board (/dispatch/weekly) · Permission: dispatch.view
Needs to change: dispatch.manage

Steps (add to a specific team)
1. On the team band click "+ Add driver" (right side of the team name). The dialog "Add Driver — <team>" opens.
2. Search with "Search drivers…" and click a driver. A driver marked "reassign" is today under another dispatcher.
3. For a driver from another team, pick a reason under "Why the driver leaves <dispatcher>" (Driver asked for a dispatcher change, Driver went on vacation, Driver left the company, Company moved the driver, or "Other…" and write it), then "Move driver". Past weeks keep their old team.
4. If the driver is not on the board at all, click "Create new driver".

Steps (create a new board row; also the top-bar "Add driver" button)
1. Dialog "Add driver to the board": fill "Driver name" (required) and "Team" (required); optional "Co-driver" (makes it a team truck), "Truck #" (kept as typed, zeros included), "Pay tag", "Phone #" (two numbers with // between).
2. Click "Add driver". A link to a driver file can be made later on "Match rows to drivers".

Edit a row: hover the driver name and click the pencil ("Edit driver"). Change name, co-driver, truck, pay tag, phone, team or "Manager comment", then "Save". Changing team asks "Why the driver leaves <dispatcher>". At the bottom, "Take off the board from <week>" with a reason and "Unassign" removes the row from that week on; "Restore" brings it back. Earlier weeks keep their rows and commission.

Import: "Import roster" takes CSV (Team / Driver / Truck columns or the sheet's own layout). Press "Preview" first, then "Apply".

Why it won't work
- "A driver name is needed" / "Pick a team" – fill the required fields.
- "Say why the driver leaves <dispatcher>" – a team change needs a reason of at least 2 characters.
- "Say why the driver is taken off the board" – Unassign needs a reason.
- "This row was changed by someone else. Reload and try again." – refresh, then edit again.
- "That driver already has a board row" – the driver file is already on the board.
- "A team needs its dispatcher name" – pick an existing dispatcher team.
- "Changing the roster takes dispatch.manage" – the buttons are for administrators and dispatch leads.

## Copy a driver's name from the board

Path: Operations › Dispatch board › Daily Board (/dispatch/daily) or Weekly Board (/dispatch/weekly) · Permission: dispatch.view (or board_daily.view / board_weekly.view)

Steps
- Daily Board: click the "Driver name" cell once to select it, then press Ctrl+C. You can also drag over the text to select it. The name copies with the co-driver as "NAME // CO-DRIVER".
- Weekly Board: click the driver's name once; it is copied and a "Copied" message shows the text.
- Right-click the name on either board to open the edit history instead.

Why it won't work
- Nothing is copied on the Daily Board: the cell must be selected (click once) before Ctrl+C.

## Weekly Board: amounts, miles and painted days

Path: Operations › Dispatch board › Weekly Board (/dispatch/weekly) · Permission: dispatch.view or board_weekly.view
Needs to change: dispatch.edit

Each driver has four rows across Monday–Sunday: "Amount", "Miles", "RPM" (worked out, read-only) and "Load #". The right side shows "Total $", "Total Mi", "Avg RPM", "Plan Reach", "Plan Adj", "Days Worked", "Efficiency", "Commission" (administrators only) and "Comment". Teams have a band with their totals; "Grand total" (or "Filtered total" while searching) is pinned at the top with "AVG / TRUCK".

Steps
1. Choose the week with the week picker (‹ "Week N · MM/DD-MM/DD" ⌄ ›). Weeks are grouped by 28-day pay period; the list stops at the current week. "This week" jumps back.
2. Amount and Miles fill in automatically from loads picked up that day (US Eastern). Several loads show as a formula like =2150+1350.
3. To override, type a number, a formula (=600+650), or for Miles "1,250 mi".
4. To paint a day, type a status word in its Amount cell (for example HOME, SHOP, VACATION, REST). The day turns that status colour and counts $0. Only a word typed in Amount paints the week; the Daily Board's status does not.
5. "Comment" is one free-text note per driver per week; it never enters totals.
6. "Report" opens the Weekly Report for the same week; "Add driver" (administrators) works as on the Daily Board.

How the summary works: Plan Reach = total − weekly goal. Plan Adj scales the goal by days worked; HOME, VACATION, SHOP, STOP and NO ANSWER take a day off the plan, REST counts as worked. Efficiency is total ÷ goal. The goal comes from the commission policy (solo or team truck).

Why it won't work
- "\"…\" is not an amount, a formula or a status word" – Amount takes a number, a formula, or a status word only.
- "\"…\" is not a mileage (a number, \"1,250 mi\" or =600+650; never negative)" – fix the Miles cell.
- "The weekly comment is kept on the week's Monday" – the comment belongs to the week; type it in the Comment column.
- "Conflict · reload to see the newer value" – someone changed the cell; Refresh and retype.
- An amber badge next to the name means "This week keeps the team / truck it ran under; the roster has moved since".
- "No drivers on the board this week." / "No drivers match." – empty week, or clear the search.

## Weekly commission on the Weekly Board

Path: Operations › Dispatch board › Weekly Board (/dispatch/weekly) › Commission column · Permission: dispatch.manage (to see the column)
Needs to change: dispatch_pay.edit

The Commission column shows each truck's calculated dispatcher commission for the week, with the rate and tier, and marks "Manual", "bonus withheld" or "junior". "Needs miles" means the truck has gross but no miles; enter the miles to price it.

Steps
1. Click the commission cell. The dialog "Commission · <driver> · week of <date>" shows the "Calculated" amount and its formula.
2. Under "Manual commission (this truck, this week)" choose "Kind": "Replace with an approved amount" or "Add an adjustment (+ / −)", enter "Amount $" and a "Reason", then "Save manual commission". "Reset to calculated" removes the manual value.
3. Under "Week eligibility" tick "Verified driver complaint this week" (withholds the RPM bonus only) and/or "Junior dispatcher rate", write the reason, then "Save eligibility".

Why it won't work
- "A reason is needed" / "Enter an amount" – fill both.
- "An amount is needed" – the server needs an amount for a manual commission.
- "A complaint or a junior rate needs a reason" – write the reason when either box is ticked.
- "A manual commission takes dispatch_pay.edit (company Administrator)." / "Week eligibility flags take dispatch_pay.edit (company Administrator)." – only the company administrator may change pay.
- "The manual commission was changed by someone else. Reload and try again." – refresh first.
- "Only an administrator can set a manual commission or week eligibility." – shown when you cannot manage.

## Performance: dispatcher leaderboard

Path: Operations › Dispatch board › Performance (/dispatch/performance) · Permission: dispatch.view or board_performance.view
Needs to change: dispatch_pay.edit (targets)

Ranks dispatchers for a period by four scores, each a percentage of a target, and their weighted average "Overall". The top three stand on a podium; the leader wears a crown. Tiles show "Dispatchers", "Loads", "Revenue", "Miles", "Fleet RPM", "On-time", "Avg overall" and "Efficiency". The table has "Rank", "Dispatcher / driver", "Drv / Truck", "Loads", "CXL", "Total gross", "Avg / truck", "Miles", "RPM", "Avg wt", "OT pick", "OT del", "On-time", "RPM%", "Efficiency", "Activity%", "Overall"; open a row to see its drivers.

Steps
1. Choose "Week", "Pay period" or "Full Month", then the period from the list (or ‹ ›).
2. "How it works" explains the scores: RPM% = average rate per mile ÷ target; Efficiency = gross ÷ (trucks × gross target × weeks); Activity% = miles per truck ÷ miles target; On-time = pickups and deliveries inside the appointment, half and half. Every load picked up in the period counts for the dispatcher whose board the driver is on; cancelled and TONU loads earn nothing and are counted in CXL.
3. Administrators: "Settings" opens "Performance targets" – "RPM target ($/mi)", "Gross per truck / week ($)", "Miles per truck / week" and the four weights "On-time", "RPM", "Efficiency", "Activity" (relative, need not add to 1). "Save targets" rescores the board.

A dash means a score could not be measured (no trucks, no miles, no recorded arrival); it is never counted as zero.

Why it won't work
- "Save targets" is grey: the three targets must be above 0, weights 0 or more, and at least one weight above 0.
- "That did not save" – usually you lack dispatch_pay.edit (the administrator's permission).
- "The performance board could not be read." – refresh the page.

## Weekly Report: drivers below the weekly target

Path: Operations › Dispatch board › Weekly Report (/dispatch/weekly/report) · Permission: dispatch_pay.view

The same week as the Weekly Board, turned into a report: biggest week first, each day painted in its status colour with amount and miles, then "Total", "Mi", "RPM", "Days", "CD / LO" (company driver / lease operator / owner operator), "Note", "Dispatcher" and "Target". The Target column shows "Target reached · $…" in green, or in red "Below $… target – Needs a dispatcher change" when the truck is under its weekly goal (solo or team goal from the commission policy). The header says how many trucks are below target.

Steps
1. Open from the tab, or press "Report" on the Weekly Board.
2. Pick the week with the week picker; "Board" goes back to the Weekly Board for that week.
3. Search with "Search driver, truck or dispatcher…".
4. "CSV" downloads the report.

It reads the same numbers as the Weekly Board, so to change a figure, edit the Weekly Board.

Why it won't work
- The tab is missing: the page needs dispatch_pay.view (administrator).
- "CSV" is grey until the week has loaded.

## Commission rules (policy versions)

Path: Operations › Dispatch board › Commission (/dispatch/commission) · Permission: dispatch_pay.view
Needs to change: dispatch_pay.edit

Shows the commission policy in force: version and effective date, "Solo/Team gross tiers" (weekly gross per truck, category, base %, RPM rule), "Solo/Team RPM bonus" bands, notes on "RPM penalty", "Soft floor" and "Five-day target", "Monthly bonuses and penalties", "Worked examples under this version" and the list of "Versions".

Steps to change the rules
1. Click "Edit rules".
2. Fill "Version label" (required) and "Effective from" (required; weeks starting on or after this Monday use it), and a "Note".
3. Edit the fields: "No-payment RPM", "Below-floor %", "Reduced %", "Junior %", "Working days"; per unit "Weekly goal $", "Soft floor $", "RPM minimum", "Bonus from $", the gross tiers and RPM bonus bands; "Lane bonus tiers"; "Penalties".
4. Check "Preview under the draft". "Reset to the document" restores the original values.
5. "Save as new version". Older versions stay; earlier weeks keep the version they were priced under.

Why it won't work
- "Give the version a label" – fill Version label.
- "Save as new version" is grey and a yellow list shows problems, e.g. "Solo gross tier 2 (…) must start above tier 1", "pays less than tier …", "soft floor (…) must equal the first gross tier", "RPM bonus threshold must not be below the soft floor", "RPM minimum (…) must be above the no-payment RPM", "RPM bonus band … starts below the RPM minimum", "weekly goal must be positive", "Lane bonus tier … must start above tier …" – fix the numbers listed.
- "Version \"…\" already exists; pick a new version label" – use a new label.
- "Changing commission rules takes dispatch_pay.edit (company Administrator)." – only the administrator may save.

## Salary Report and salary runs

Path: Operations › Dispatch board › Salary Report (/dispatch/salary) · Permission: dispatch_pay.view (the page also requires dispatch.manage)
Needs to change: dispatch_pay.edit and dispatch.manage

Dispatcher pay for a "Week", "28-day pay period" or "Calendar month", priced by the same engine as the Weekly Board. The table lists each "Dispatcher team" with weekly figures, "Gross", "Miles", "RPM", "Commission", "Bonuses", "Penalties", "Payable" and "Allocation". Each team has "Show calculation proof" with every truck-week and its formula.

Steps
1. Pick the period kind and the period. "Excel" and "CSV" download it.
2. "Start a draft run" creates the run (status draft; figures are live).
3. "Send to review" → status review. From review: "Back to draft" or "Finalize". Finalize freezes a snapshot ("Frozen snapshot · later board or rule edits do not change it").
4. A final run can be reopened with "Reopen" and a reason (at least 3 characters); it goes back to review with live figures and the reopen is audited.
5. "Shares" (per team): split the team's commission between people – pick each "Employee", "Share %", "Add person", "Effective from", then "Save shares". Shares must total 100 %.
6. "+ Adjustment" (per team): choose "Kind" (Dedicated lane bonus, DNU penalty, Driver departure penalty, Freight Guard penalty, Junior forfeiture (admin decision), Other approved bonus, Other approved penalty), "Affected month", amount, "Affected employee", "Approved by" (required), "Reason" (required), then "Record". Adjustments can be voided with "void" and a reason.

Shares, adjustments and voids are hidden while the run is final.

Why it won't work
- "The salary report is for administrators." – you lack dispatch.manage.
- "A run for this period already exists" / "Only a draft can go to review" / "Only a run in review can go back to draft" / "A run is finalized from review" / "Only a final run can be reopened" – follow draft → review → final.
- "Shares do not total 100 % for <teams>" – fix the team's shares before Finalize.
- "Shares total X %; they must total 100 %" / "Pick the staff record for every share: Payroll pays a share only to a person on file."
- "Reopening a final run needs a reason".
- "Enter the amount"; "A bonus is a positive amount"; "A penalty or forfeiture is a negative amount".
- "The <month> month is inside a finalized salary run (…). Reopen it first." / "That month is inside a finalized salary run. Reopen it first."
- "A dedicated lane bonus is already recorded for that team and month".
- "Voiding needs a reason" / "Already voided".
- "The salary run was changed by someone else. Reload and try again."
- "Changing dispatcher compensation takes dispatch_pay.edit (company Administrator)."

## Detention & Layover claims

Path: Operations › Dispatch board › Detention & Layover (/dispatch/claims) · Permission: dispatch.view or board_claims.view
Needs to change: dispatch.manage

One claim per load number for detention, layover, TONU or other accessorial money. Columns: "Load #", "Type", "Driver", "Date", "Requested", "Recovered", "Updater", "Updater payout", "Status", "Notes", with totals at the bottom. Recovered money never enters dispatcher commission.

Steps
1. Click "New claim" (administrators and dispatch leads).
2. Fill "Load #" (required), "Type" (detention, layover, tonu, other), "Date", "Driver", "Requested $", "Recovered $", "Updater", "Updater payout $", "Status" (open, submitted, recovered, partial, denied, paid), "Notes".
3. Click "Save". The toast says "Claim recorded".
4. To edit, click the claim row, change it and "Save" ("Claim updated").
5. To remove a wrong claim, open it and press "Void"; give a reason (kept on the audit). Claims are never deleted.
6. Search with "Search load, driver, updater…"; "CSV" downloads the list.

Why it won't work
- "Load <number> already has a claim" – only one live claim per load; open the existing one.
- "Recovered cannot exceed requested" – lower Recovered or raise Requested.
- "The updater payout cannot exceed what was recovered" – lower the payout.
- "This claim was changed by someone else. Reload and try again." – refresh and redo.
- "Voiding needs a reason" – give a reason of at least 3 characters.
- "Editing claims takes dispatch.manage" / "Voiding claims takes dispatch.manage" – "New claim" and editing are not available to view-only users.

## Match board rows to driver files

Path: Operations › Dispatch board › Match rows to drivers (/dispatch/roster-match) · Permission: dispatch.manage

A board row imported from the sheet is just a name and truck number; it sees loads only after it is linked to a driver file. This page suggests matches; nothing is matched automatically.

Tiles: "Rows with no driver file", "Rows already linked", "Driver files on the company".

Steps
1. For each row, choose one candidate (radio button). Each shows its reasons and a confidence ("exact", "strong" or weaker). When two files could be the person, nothing is preselected – pick deliberately.
2. Click "Confirm match". The toast says "Matched" – "The row now carries the driver file and will show their loads."
3. If the driver already has a board row, the button reads "Review the merge". The dialog "Merge with <driver>" shows "Keeps its place" and "Is retired into it" side by side; for each disagreement choose "Keep" or "Take the imported one", then "Merge the rows".
4. Rows with no candidate keep working as board-only rows; create the driver in Drivers first, then come back.

Why it won't work
- "You cannot change the roster" – the page needs dispatch.manage.
- "<N> still to decide" (merge button grey) – answer every disagreement.
- "<name> already has a board row. Confirming this match merges the two rows - the screen has to say so first." – use "Review the merge".
- "Choose which value to keep for: …" – answer the listed fields.
- "<name> is already linked to a driver file" / "<name> changed while you were looking at it. Reload and try again." – refresh the page.
- "Every driver file already has a board row" – the remaining rows have no driver file at all; create them in Drivers.

## Drivers on vacation (On vacation tab)

Path: Operations › Dispatch board › On vacation (/dispatch/vacations) · Permission: dispatch.view or drivers.view

Shows who is away. Figures: "On vacation", "Returning this week", "Away 30+ days". Company rule: 30+ days away requires a Safety review and a drug test before the next load.

Steps
1. Tabs "On vacation" and "Recently returned · last 30 days". Search "Search driver (name or unit #)" or filter by dispatcher.
2. Click a driver to see "Away since", "Expected return", "Days away", "Return readiness" (Safety review state, "Next load: Cleared by Safety / Not cleared"), and "Related costs".
3. "View driver" opens the driver page; "Open Safety review" (Safety users) opens the vacation-return review.

How a vacation starts and ends: on the driver page, the "⋮" (More actions) menu has "Send on vacation" (fill "Vacation start", optional "Expected return" and "Reason / note"). While away, "Manage vacation" offers "Edit vacation", "Record actual return" and "Cancel vacation". Setting VACATION on the Daily Board also starts one, and a later on-duty word ends it. Needs drivers.edit or dispatch.manage.

Why it won't work
- "A vacation starts today or earlier" – future starts are not supported.
- "The expected return cannot be before the start".
- "<name> is already on vacation." / "This driver already has an open vacation."
- "A driver who is <status> cannot be sent on vacation; only available or off duty." – finish or release the load first.
- "This overlaps the vacation from …" – correct or cancel the other one.
- "The actual return cannot be in the future" / "…cannot be before the start" / "The return was already recorded on …".
- "Vacations need drivers.edit or dispatch.manage." – the menu item is hidden without them.

## Dispatcher rotation report

Path: Operations › Dispatch board › Dispatcher rotation (/dispatch/rotation) · Permission: dispatch.manage

Tracks drivers moving between dispatcher teams. Rotation = drivers who left ÷ drivers on the team at the start of the period.

Steps
1. Pick a period: "This month", "30 days", "90 days", "This year", or set "From" and "To" dates.
2. Summary: "Starting drivers", "Joined", "Left", "Drivers at period end".
3. "Dispatch teams" lists each dispatcher with "Start", "Joined", "Left", "At end", "Rotation" and a "Total" row. Search with "Search dispatcher…".
4. Click a dispatcher to see their moves under "All changes", "Joined", "Left", each with the reason given when the driver was moved (or "No reason recorded").

Reasons come from the "Why the driver leaves …" choice made when a driver is moved or taken off the board.

Why it won't work
- "Administrators and dispatch leads only" – needs dispatch.manage.
- "Pick a period" – "The start date has to be on or before the end date."
- A dash in Rotation means no drivers at the start of the period.

## Vacation return reviews (Safety clearance after 30+ days)

Path: Operations › Vacation returns (/safety/vacation-returns) · Permission: safety.view
Needs to change: safety.manage (clear, upload, notes); safety_testing.manage with safety.manage (open and record the test); accounting.view with safety.manage (link expense)

Company policy (separate from the DOT return-to-duty program): a driver away 30 days or more needs a vacation-return drug test and a Safety review before the next load. Tiles: "Awaiting review", "Test pending", "Cleared this week". Statuses: Test required, Appointment scheduled, Result pending, Result received, Cleared, Not cleared.

Steps
1. In "Return review queue", search "Search driver or unit…" or filter by status, then click "Review".
2. The "Return review" panel shows the vacation dates and the "Review checklist": "Documents valid" (CDL and medical card in date), "Required test result", "Safety review".
3. "Open the test", then enter "Collected (ET)" and "Record collection", then choose the result and "Record result". "Upload" files the test result paper.
4. Write a note under "Notes" if needed.
5. When everything is done, click "Clear for dispatch". The driver shows "Cleared for dispatch by …".
6. Under "Cost & history", "Link an existing expense" attaches an Accounting expense (nothing is posted from here).

Why it won't work
- "Clear for dispatch" grey with "Complete required items first: …", for example "No vacation-return test on file", "The test has not been collected", "The test result is not recorded as negative", "CDL expired …", "No CDL expiry on file", "Medical card expired …", "No medical card expiry on file".
- "The driver cannot be cleared yet" – same blockers from the server.
- "Open the review first: schedule the vacation-return test".
- "The company test applies from 30 days away" / "This vacation was cancelled".
- "That expense is void" / "That expense is already linked to …".
