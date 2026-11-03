# General: signing in, finding your way, and NeWay AI

How to sign in, switch company, find pages, change the look of the app, read the Dashboard, Notifications, Company info, Reports and Analytics, and how to use the NeWay AI assistant itself. Every time in NeWay TMS is US Eastern time.

## Sign in to NeWay TMS

Path: the sign-in screen (/login) · Permission: none

What it is for: every person signs in with the account an administrator created for them. There is no self sign-up.

Steps
1. Open the NeWay address. If you are not signed in you land on the sign-in screen.
2. Type your address in "Email or username". A plain username also works when it matches exactly one account (for example "admin" for admin@...).
3. Type your "Password".
4. Leave "Remember me" ticked to stay signed in on this computer; untick it on a shared computer.
5. Press "Sign in". You are taken to the page you were opening, or to your first page.

What happens after
- The very first time, with a temporary password, you must choose your own password before anything else opens (see "Change a temporary password at first sign-in").
- A session lasts 12 hours, then you sign in again.
- An invited account becomes Active the first time it signs in.
- "Forgot password?" does not send an email. It tells you: "Password resets are handled by an administrator: ask them to issue a new temporary password from the Users screen."

Why it won't work
- "Invalid email or password." - the address or password is wrong (the screen never says which). Check spelling and Caps Lock; if you forgot the password ask an administrator for a new temporary password.
- "This account is not active. An administrator has to re-enable it." - your account was suspended or disabled. Ask an administrator to set it back to Active on Administration › Users.
- "This company has been deactivated. Contact the platform administrator." - the whole company was switched off on the Companies page.
- "The server could not be reached. Check your connection and try again." - no network or the server is down.
- "Your account has no access yet" after signing in - the account has no role. Press "Check again" after an administrator gives you a role on Administration › Users ("Change roles"). Your password is fine.

## Change a temporary password at first sign-in

Path: the "Choose a password" screen (shown automatically after sign-in) · Permission: none

What it is for: an administrator gives new people (and people who forgot their password) a temporary password. It must be replaced before any other screen opens.

Steps
1. Sign in with the temporary password you were given.
2. On "Choose a password" ("Your temporary password must be changed before continuing.") type a "New password" of at least 10 characters.
3. Type it again in "Confirm new password".
4. Press "Set password and continue". You go to your first page.
5. "Sign out" leaves without changing it.

Why it won't work
- "Use at least 10 characters" - the new password is too short.
- "The two passwords do not match" - the two boxes differ.
- "Choose a password different from the temporary one." - you typed the temporary password again.
- The button stays grey until both rules above are met.
- "The password could not be changed." - the server refused; try again or ask an administrator for a new temporary password.

## Work in more than one company and switch company

Path: top bar › company name (switcher) · Permission: membership in each company

What it is for: one person can work in several companies with one email and one password. The switcher appears in the top bar only when you belong to two or more companies.

Steps
1. Sign in normally. You land in the company you used last.
2. Click the company name in the top bar. The menu "Switch company" lists your companies; the current one is ticked.
3. Pick another company. A new session starts in that company and the app reloads from the start, so nothing from the first company is shown in the second.
4. Your roles and permissions can be different in each company.

How a second company is added: an administrator of that company adds you on Administration › Users with your existing email. You are told: "They already sign in to another company: same email and password. They switch company in the top bar." No new password is created.

Why it won't work
- "Could not switch company" with "You are not a member of that company." - you were removed from it.
- "Your account in that company is not active." - suspended or disabled there; ask that company's administrator.
- "That company has been deactivated." - the platform administrator switched the company off.

## Why a page is missing from my sidebar

Path: the sidebar on the left · Permission: depends on the page

What it is for: the sidebar is grouped (Company, Operations, Fleet, Safety & Compliance, Accounting, HR, Driver Support, Quality, Reports, Administration). Each page needs a permission. A page you do not have permission for is absent: not greyed out, not listed, and not found by search. If you type its address you are sent to the first page you may open. The company owner sees every page.

Examples of page permissions
- Dashboard: dashboard.view (built-in only for Administrators). NeWay AI: ai_assistant.use. Company info: company_profile.view. Notifications: everyone.
- Reports: reports.view. Analytics: analytics.view.
- Administration pages: users.view, employees.view, roles.view, departments.view, integrations.view, workflows.view, audit.view, settings.view. Companies: only a platform (grand) administrator.

Tips
- Click a group heading to fold or unfold it. Press "[" to collapse or expand the whole sidebar ("Collapse sidebar" / "Expand sidebar").
- On a phone, press "Open navigation" (the menu icon) in the top bar.
- Some pages are opened by tabs inside another page (for example the Dispatch board tabs), so they are not separate sidebar links.

What to do: if you need a page you cannot see, ask an administrator to add the permission to your role on Administration › Roles & Permissions, or to give you another role on Administration › Users.

## Search and the command palette

Path: top bar › "Search anything…" · Shortcut: Ctrl+K (Cmd+K on Mac) · Permission: none

What it is for: jump to any page you may open, or to a truck, trailer, driver, load, customer, broker, invoice or employee.

Steps
1. Press Ctrl+K, or click "Search anything…" (on a phone, the search icon).
2. Type. Pages you may open are listed straight away; records appear once you have typed two characters, grouped as Trucks, Trailers, Drivers, Loads, Customers, Brokers, Invoices and Employees.
3. Use the arrow keys and Enter, or click, to open one. "Esc" closes the palette.
4. "No results for …" means nothing matched.

Other top bar help: the "Help" button lists keyboard shortcuts ("Command palette", "Toggle sidebar" [, "Move between nav items" ↑ ↓, "Close overlay" Esc).

## Account menu, Appearance (Light, Dark, System) and Sign out

Path: top bar › your name (account menu) · Permission: none

What it is for: your own preferences and signing out.

Steps
1. Click your name and avatar at the top right ("Account menu").
2. Under "Appearance" pick "Light", "Dark" or "System". The change shows at once and is saved to your account, so it follows you to every computer ("Saved to your account on every device."). "System" follows your computer's own setting ("Follows your computer's setting.").
3. "Users and access" opens Administration › Users (shown only if you have users.view).
4. "Sign out" ends your session on this browser.

Notes: documents (PDF and image previews) stay on a light background in dark mode on purpose, so they look like paper.

## Time zone: all times are US Eastern

Every clock in NeWay TMS is US Eastern (America/New_York): times shown on screens, form defaults, "today", business dates, weeks, pay-period and salary cutoffs, invoice and money days. The browser's own time zone is never used, and "now" comes from the server clock, so a laptop with a wrong clock still shows the right time.

- The top bar clock shows the Eastern time with its abbreviation (EST or EDT), and the Tashkent time underneath, so the night desk does not have to convert.
- Stop appointments and arrivals keep the stop's own local time zone and are shown beside the Eastern time, never instead of it.
- NeWay AI groups chats into Today / Yesterday by Eastern time, and its monthly budget resets on the 1st by Eastern time.

## Dashboard

Path: Company › Dashboard (/dashboard) · Permission: dashboard.view
Money figures need: dashboard.view_financial · Drill-downs need: dashboard.drilldown

What it is for: the company's numbers in one place. Built in only for Administrators; a company can grant it to its own role on purpose. Without dashboard.view the Dashboard is not in the sidebar and the start page sends you to your first allowed page instead.

Sections: "Executive overview", "8-week performance", "Operating economics", "Operations" (dispatch performance and at-risk loads), "Insurance claims", "Fleet economics" (fuel and fuel by state) and "Driver type detail".

Steps
1. Choose the period: "Today", "This week", "Last week", "This month", "Last month" or "Custom range". "Period in progress" means the period has not ended.
2. Press "Refresh" to reload all widgets.
3. Click a figure that supports it to open its drill-down.
4. "Display mode" fills a wall screen; "Exit display mode" or Esc leaves it.

Why it won't work
- Money shows as "••••••" - you lack dashboard.view_financial.
- "Customize" only says "Dashboard customization arrives in a later phase".
- A widget shows "Unable to load ..." (for example "Unable to load the executive overview") - press "Refresh"; if it persists the server could not answer.

## Notifications

Path: Company › Notifications (/notifications), or the bell in the top bar · Permission: none

What it is for: events about loads, trucks, drivers, invoices, documents and the system. The bell shows the number unread and opens a side panel with "All" and "Unread" tabs and "Mark all read".

Steps on the full page
1. Use the tabs "All", "Needs action", "Unread", "Mentions" and "System".
2. Search with "Search notifications (load #, unit #, driver, etc.)" and filter by "Type", "Priority" and "Date".
3. Press the row's action button to open the record. The "…" menu has "Mark as read" / "Mark as unread", "Mute ... notifications" and "Delete notification".
4. "Mark all read" clears the unread count.
5. "Notification preferences" switches categories on or off: "Loads & dispatch", "Fleet & maintenance", "Drivers", "Finance", "Documents", "System". A muted category is hidden from the list and counts.
6. "Notification delivery": "In-app" is always on. "Email" and "Telegram" show "Not connected": the choice is stored but nothing is sent through them yet.

Why it won't work
- "No notifications" / "Every category is muted. Switch one back on to see events here." - turn a category back on.
- Late or action-required items about a load that is already delivered, closed or cancelled are dropped automatically.

## Company info and the broker packet

Path: Company › Company info (/company) · Permission: company_profile.view
Needs to change: company_profile.edit

What it is for: the carrier's own profile (legal name, DBA, MC, DOT, SCAC, EIN, contacts, addresses, insurance agent, factoring and NOA reference), its papers, trailer yards, and the broker setup packet.

Steps
1. Press "Edit company" to change details and trailer yards ("Add yard": "Name" is required, "Address" and "Note" optional), then "Save".
2. In "Documents" press "Upload" (or "Replace") on a slot: W-9, MC authority, Certificate of insurance and Notice of assignment are required and go into the packet; EIN letter, UCR, Voided check / bank letter are optional. "Add document" adds an "Other" paper with a "Name". Choose the "File", optional "Issued", "Expires" (required for the certificate of insurance), "Note", then "Upload". A replaced file stays in its history.
3. To remove a paper press the bin, give "Why" (at least 3 characters) and "Remove". It stays on record.
4. When the banner says "Broker packet ready" press "Download broker packet": a ZIP of the current W-9, COI, MC authority and NOA.

Statuses: "On file", "Expires soon" (within 30 days), "Expired", "Missing".

Why it won't work
- "Download broker packet" is grey with "Broker packet incomplete" - upload the missing required papers or replace the expired ones; the banner says which.
- "The broker packet is not ready: ..." - same cause, from the server.
- "A certificate of insurance needs its expiry date." / "It cannot expire before it was issued." - fix the dates.
- "Someone changed the company info since you opened it. Reload to see their changes, then edit again."
- "Changing company info needs the Company info edit permission." - ask for company_profile.edit.
- "That file is not in this company’s file store. Upload it again."

## Reports

Path: Reports › Reports (/reports) · Permission: reports.view
Financial reports need: reports.view_financial · Workforce: reports.view_people · Safety: reports.view_safety

What it is for: run, save and export operational, financial, fleet, driver, people and safety reports. Only reports you have permission for are listed.

Steps
1. On "Report library" use "Search reports…" and pick a report (for example "Profit & loss", "Revenue by week", "Cost per mile", "Truck profitability", "Fleet utilisation", "Fuel", "Maintenance cost", "Driver performance", "Miles", "Load profitability", "Dispatch performance", "Employee headcount", "PTO", "Attendance", "Onboarding", "Recruiting").
2. Set "Period" ("Today", "This week", "Last week", "This month", "Last month") and, where shown, "Department" and "Status".
3. Press "Run report".
4. "Export CSV" downloads the rows; "Save view" stores the settings under a "Name" (not the results). Saved views are on the "Saved" tab and run again on current data when opened.

Why it won't work
- A report marked "No data" says "... cannot be produced yet" with the reason (for example Accounts receivable, Customer and Broker performance, On-time performance, Maintenance downtime, Safety).
- "No rows for this period" - the report ran and the period is empty; choose another period.
- "You do not have reports.view_financial" (or another code) - ask for that permission.
- "A saved report called "..." already exists" - choose another name.

## Analytics

Path: Reports › Analytics (/reports/analytics) · Permission: analytics.view

What it is for: trends and comparisons, each period compared with the previous one. Tabs: "Executive", "Financial", "Operations", "Fleet", "Drivers", "Workforce".

Steps
1. Choose the period at the top right ("Today", "This week", "Last week", "This month", "Last month"). The line under the title states the range and the comparison range, and whether figures come from live records.
2. Executive and Financial show "Weekly performance" (Gross, Cost, Profit), "Needs attention" with "Open" links, and "Where the money goes" (cost per category, per mile, % of revenue, vs previous).
3. Operations shows loads delivered and loaded, empty and total miles. Fleet shows fuel spend, gallons, average $/gal, fuel per mile and "Truck profitability". Drivers shows "Driver revenue". Workforce shows headcount, drivers, office staff, onboarding, PTO awaiting decision and attendance exceptions.

Why it won't work
- "No financial data for this period", "No cost data for this period", "No truck activity for this period", "No driver activity for this period" - nothing was recorded in the range; widen it.
- "Analytics could not be loaded" - the server refused or failed; the message says why.

## NeWay AI: open it, chats and history

Path: Company › NeWay AI (/ai), or the "NeWay AI" button on every page · Permission: ai_assistant.use

What it is for: an assistant that answers "how do I" questions from this guide and looks up accounting facts with your own permissions. Your chats are private to you in this company.

Steps
1. Press the "NeWay AI" button in the corner of any page. A side panel opens with "New chat". "Open full page" moves the same chat to /ai.
2. On /ai, the left column has "New chat", "Search chats" (searches chat names) and your chats grouped "Today", "Yesterday", "Previous 7 days", "Older".
3. Start from a quick action ("Check Ready-to-Bill loads", "Generate driver statements", "Calculate dispatcher payroll", "Show overdue invoices") or type in "Ask NeWay AI…". Enter sends; Shift+Enter makes a new line. "Stop" stops waiting.
4. A new chat is named after its first message. Open a chat's "Chat actions" (…) to "Rename" (Enter saves, Esc cancels) or "Archive". Archived chats leave the list.
5. Answers may show tables, notices, download cards and "Open ..." links made from the system's own data.

What it can look up: the user guide, one load by number (needs loads.view), overdue invoices, the billing queue, invoices ready for RTS and driver statement previews (all need accounting.view), and dispatcher pay (needs dispatch_pay.view and dispatch.manage). If you lack a permission the answer says "You do not have access to ... (code)."

Why it won't work
- No "NeWay AI" button or menu item - you lack ai_assistant.use.
- "NeWay AI is not connected on this server yet. An administrator has to add the key."
- "No such conversation." - the chat was archived or is not yours.

## NeWay AI: attachments, model choice, speech and Read aloud

Path: NeWay AI (/ai or side panel) › message box · Permission: ai_assistant.use

Steps
1. Attach: press "Attach" (+) and choose "Upload photo", "Take photo" or "Attach file" (PDF or PNG, JPEG, WEBP). Up to 5 files per message; remove one with its ×.
2. Model: when more than one model is enabled, the model button (for example "Claude Haiku 4.5" Fast, "Claude Sonnet 5.5" Advanced) picks it.
3. Speak: the language button cycles "UZ", "RU", "EN". Press "Speak" (microphone), talk, then edit the text before sending. Press again ("Stop listening") to stop. Works in Chrome or Edge.
4. "Read aloud" under an answer reads it with the browser's voice.

Why it won't work
- "... was not attached" - the upload failed; try again.
- "NeWay AI reads images and PDFs only." / "... cannot read images. Choose a model that can."
- "An attachment is not in this company’s file store. Upload it again."
- "This browser cannot turn speech into text. Use Chrome or Edge, or type."
- "Microphone access was refused. Allow it in the browser’s site settings." / "No microphone was found." / "Nothing was heard. Try again a little closer to the microphone."
- "No voice for this language is installed on this computer." - Read aloud has no voice installed. On Windows: Settings › Time & language › Speech › Add voices.

## NeWay AI: Dry run, RTS proposals and Confirm

Path: NeWay AI › "Dry run" switch in the chat header · Permission: ai_assistant.use
Turning Dry run off needs: ai_assistant.manage · Confirming an RTS send needs: accounting.edit

What it is for: NeWay AI never sends, pays or changes anything without a person's OK. To send invoices to RTS it prepares a proposal card that a person must confirm. When it works on the screen, Dry run means it never presses a risky button (approve, send, pay, delete…); it may still open pages, type and press harmless buttons (see "NeWay AI works on the screen for you: cursor, Stop, Allow / Don't").

How it works
1. Every new chat starts with "Dry run" on (orange badge). In Dry run actions are prepared but never sent. The tooltip says: "Dry run: actions are prepared, never sent. Only an administrator can turn it off."
2. Ask, for example, "send the ready invoices to RTS". The card "Send N invoices to RTS" lists each invoice, debtor and amount, the total, "To RTS Financial · FTPS", and any invoice that is blocked with its reason. Status "Awaiting confirmation".
3. A person with ai_assistant.manage can switch Dry run off for that chat (badge "Live"). This is audited.
4. Press "Confirm" to send, or "Cancel". On confirm the invoices are re-checked; if anything changed the card becomes "Out of date". Otherwise it shows "Running", then "Done" (batch number and files uploaded) or "Failed".

Why it won't work
- "Confirm" is grey with "Dry run is on: nothing will run." - ask an ai_assistant.manage holder to turn Dry run off.
- "Only an administrator can turn Dry run off." - you lack ai_assistant.manage.
- "Sending to RTS needs the Accounting edit permission."
- "Changed since the preview: ... Ask again for a fresh preview." - an invoice changed; ask again.
- "This proposal is already ..." / "This proposal was just confirmed elsewhere."

## NeWay AI works on the screen for you: cursor, Stop, Allow / Don't

Path: any page, with the "NeWay AI" panel (or /ai) · Permission: ai_assistant.use (plus your own permissions for each page and button)

What it is for: since 2026-10-21 NeWay AI can do a job on the screen the way you would: open pages, read them, type into fields, choose from lists, tick boxes and press buttons, in your own browser and with your own permissions. You watch it happen and can stop it at any time.

How it works
1. Ask it to do something ("Open load L-100009 and record the POD"), or press "Do it for me" on a "Show me" card. ("Show me: …" only points at the button; it does not press it.)
2. The chat panel steps aside and a small window in the bottom-right corner, "NeWay AI is working", shows each step: "Reading the screen…", "Opening /loads…", "Clicking ‘…’…", "Typing into ‘…’…", "Choosing ‘…’…".
3. A cursor labelled "NeWay AI" moves on the page, outlines the control it is about to use and shows a ripple when it presses. Your own mouse keeps working.
4. Press "Stop" at any time: it stops at once and the remaining steps are cancelled ("Cancelled: the person pressed Stop.").
5. If you click or type on the page yourself, it pauses: "NeWay AI paused because you used the page. Continue?" Press "Continue" to let it go on.
6. Before a risky press the window says "NeWay AI needs your OK": "NeWay AI wants to press ‘<button>’ on <where>." Press "Allow" to let it press, or "Don’t" to refuse (it does not try again).
7. When it is done the window says "NeWay AI finished". Press "Open chat" to read its summary, or "Close". If a run did not finish, the chat shows "This screen run did not finish." with "Stop it" and "Continue on screen".

Risky presses (always asked, never done silently): any button whose name has approve, post, pay, send, submit, issue, delete, remove, void, reopen, sign, transfer, apply or disable, plus "Record payment" and "Cancel load". Pressing Enter in a form counts as pressing its submit button. Opening tabs, typing, choosing options, "Cancel", "Close" and "Apply filters" are not risky.

Dry run: with "Dry run" on (the default), a risky press is never made. The step says "dry run: would press ‘<button>’ (not pressed - Dry run is on)." Opening pages, typing and harmless clicks still happen, so you can watch it prepare the work and press the final button yourself. With Dry run off ("Live", only an ai_assistant.manage holder can switch it), each risky press asks Allow / Don't.

Limits
- It only does what your role allows; a page or button you cannot use, it cannot use either. A greyed-out button is never pressed.
- It never invents values: if it needs a number or a reason it does not have, it asks you.
- It never presses anything inside its own chat window.
- Up to 40 steps per request when it drives the screen; then "NeWay AI stopped after several steps. Ask again more narrowly."

Why it won't work
- Nothing happens on the screen: it answered in the chat instead; ask "do it for me on the screen".
- "NeWay AI paused because you used the page. Continue?" - you clicked or typed on the page; press "Continue".
- "‘…’ is disabled; it cannot be pressed now." - the button is greyed out (missing data or permission); fix that first.
- "NeWay AI could not go on." - the page changed under it; ask again.

## NeWay AI: monthly spend cap and errors

Path: NeWay AI (/ai) › "This month" meter (bottom left) · Permission: ai_assistant.use

What it is for: the company has a monthly AI budget ($20 by default). The meter shows "$spent of $cap". From 80% it says "Near the cap"; at 100% "Budget used up". It resets on the 1st (Eastern).

Why it won't work
- "This month’s NeWay AI budget is used up. It opens again on the 1st, or an administrator can raise the cap." - the message box and quick actions are disabled until then.
- "NeWay AI is busy. Try again in a minute." / "NeWay AI did not answer. Try again."
- "The Anthropic account has no credit left." / "The Anthropic key on the server was refused." / "NeWay AI is not set up: the server has no Anthropic key." - an administrator must fix the server account.
- "The answer was cut short. Ask a narrower question." / "NeWay AI stopped after several steps. Ask again more narrowly."
- NeWay AI can be wrong: "Nothing is sent or paid until you confirm."
