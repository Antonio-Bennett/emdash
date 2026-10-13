---
"@emdash-cms/admin": patch
"emdash": patch
---

Adds drag-and-drop rescheduling and a week view to the admin calendar, and fits the month view to the screen.

- The month grid fills the window with one-line entries and shows as many per day as fit, folding the rest into "+N more".
- The week view places each entry at its time on an hour grid in the site's time zone.
- People who can publish an entry can drag it to another day, keeping its time, or to another time in the week view, in 15-minute steps. The confirmation offers Undo.
- Authors and above get a + on each day from today onward that creates a draft with a title, collection, and time, schedules it, and opens it.
- The Drafts button lists unscheduled drafts you can publish. Drop one on a month day to schedule it for 9:00 in the site's time zone, or on a time in the week view.
- On wide screens the entry panel sits beside the calendar instead of covering it, and clicking empty space closes it. On phones it is a bottom sheet that swipes down to close.
- Keyboard shortcuts: T goes to today, J and K to the next and previous period, and M, W, and A switch between month, week, and agenda.

The week view and the Drafts pane need a wide screen; phones keep the month and agenda views.
