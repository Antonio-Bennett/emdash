import {
	DndContext,
	DragOverlay,
	MouseSensor,
	TouchSensor,
	pointerWithin,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
	type Active,
	type DragEndEvent,
	type DragMoveEvent,
	type Over,
} from "@dnd-kit/core";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import {
	minutesInZone,
	zonedInstant,
	type CalendarDisplay,
	type CalendarItem,
} from "../../lib/calendar.js";
import { CalendarEntryChipPreview } from "./CalendarEntry.js";

/** One hour's height in the week view, in pixels. */
export const HOUR_HEIGHT = 48;
/** Dragging in the week view moves an entry in steps of this many minutes. */
const SNAP_MINUTES = 15;
/** A draft dropped on a month day goes live at the start of the working day. */
const DRAFT_DAY_MINUTES = 9 * 60;

/** An unscheduled draft that can be dropped on the calendar. */
export interface CalendarDraft {
	collection: string;
	id: string;
	locale: string;
	title: string;
}

type Dragged =
	| {
			item: CalendarItem;
			/** Minutes past midnight the entry's chip is drawn at, in the week view. */
			placedAt?: number;
	  }
	| { draft: CalendarDraft };

interface DropTarget {
	day: string;
	/** Week columns place the entry at the height it is dropped at. */
	column?: React.RefObject<HTMLElement | null>;
}

interface DragState {
	dragged: Dragged;
	/** Where it would land if dropped now. */
	time?: number;
	allowed: boolean;
}

function readDragged(active: Active): Dragged | undefined {
	const data = active.data.current;
	if (data?.item) {
		return { item: data.item as CalendarItem, placedAt: data.placedAt as number | undefined };
	}
	if (data?.draft) return { draft: data.draft as CalendarDraft };
	return undefined;
}

function readTarget(over: Over | null): DropTarget | undefined {
	return over?.data.current as DropTarget | undefined;
}

/** The entry a dragged draft would become, for the preview. */
function previewItem(dragged: Dragged, time: number | undefined): CalendarItem {
	if ("item" in dragged) return { ...dragged.item, time: time ?? dragged.item.time };
	const { draft } = dragged;
	return {
		...draft,
		status: "draft",
		kind: "scheduled",
		at: "",
		key: `draft:${draft.collection}:${draft.id}`,
		time: time ?? Number.NaN,
		day: "",
		state: "scheduled",
	};
}

interface CalendarDragProviderProps {
	display: CalendarDisplay;
	now: number;
	/** Called with the new time when an entry is dropped on another day or time. */
	onMove: (item: CalendarItem, scheduledAt: string) => void;
	/** Called with the time when a draft is dropped on the calendar. */
	onScheduleDraft: (draft: CalendarDraft, scheduledAt: string) => void;
	/** Called when something is dropped on a time that has passed. */
	onPastDrop: () => void;
	children: React.ReactNode;
}

/**
 * Lets scheduled entries and unscheduled drafts be dropped on a day in the
 * month, or at a time in the week.
 */
export function CalendarDragProvider({
	display,
	now,
	onMove,
	onScheduleDraft,
	onPastDrop,
	children,
}: CalendarDragProviderProps) {
	const { t } = useLingui();
	// On touch screens a drag starts with a long press, so swipes still scroll.
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
	);
	const [drag, setDrag] = React.useState<DragState | null>(null);

	const landing = (event: DragMoveEvent): number | undefined => {
		const dragged = readDragged(event.active);
		const target = readTarget(event.over);
		if (!dragged || !target) return undefined;
		const item = "item" in dragged ? dragged.item : undefined;
		const itemMinutes = item ? minutesInZone(item.time, display.timeZone) : DRAFT_DAY_MINUTES;
		const column = target.column?.current;
		const dropped = event.active.rect.current.translated;
		let minutes = itemMinutes;
		if (column && dropped) {
			// Both rects are measured now, so scrolling the grid during the drag is accounted for.
			const pointed = ((dropped.top - column.getBoundingClientRect().top) / HOUR_HEIGHT) * 60;
			const snap = (value: number) => Math.round(value / SNAP_MINUTES) * SNAP_MINUTES;
			// An entry moves by whole steps from its own time, measured from where its chip is drawn;
			// a draft lands on a step.
			const drawnAt = "item" in dragged ? (dragged.placedAt ?? itemMinutes) : 0;
			const from = item ? itemMinutes : 0;
			const step = snap(pointed - drawnAt);
			// The earliest and latest steps that stay on the day.
			const first = -Math.floor(from / SNAP_MINUTES) * SNAP_MINUTES;
			const last = Math.floor((24 * 60 - 1 - from) / SNAP_MINUTES) * SNAP_MINUTES;
			minutes = from + Math.min(Math.max(step, first), last);
		}
		if (item && target.day === item.day && minutes === itemMinutes) return item.time;
		return zonedInstant(target.day, minutes, display.timeZone);
	};

	const titleOf = (active: Active) => {
		const dragged = readDragged(active);
		return dragged ? ("item" in dragged ? dragged.item.title : dragged.draft.title) : "";
	};
	const accessibility = {
		announcements: {
			onDragStart: ({ active }: { active: Active }) => {
				const title = titleOf(active);
				return t`Picked up ${title}.`;
			},
			onDragOver: ({ active, over }: { active: Active; over: Over | null }) => {
				const title = titleOf(active);
				const target = readTarget(over);
				if (!target) return t`${title} is not over a day.`;
				const date = display.fullDate(target.day);
				return t`${title} is over ${date}.`;
			},
			onDragEnd: ({ active, over }: { active: Active; over: Over | null }) => {
				const title = titleOf(active);
				const target = readTarget(over);
				if (!target) return t`${title} was dropped outside the calendar.`;
				const date = display.fullDate(target.day);
				return t`${title} was dropped on ${date}.`;
			},
			onDragCancel: ({ active }: { active: Active }) => {
				const title = titleOf(active);
				return t`Moving ${title} was cancelled.`;
			},
		},
		screenReaderInstructions: {
			draggable: t`To reschedule an entry with the keyboard, open it and choose Reschedule.`,
		},
	};

	const update = (event: DragMoveEvent) => {
		const time = landing(event);
		setDrag((current) => {
			if (!current) return current;
			const unchanged = "item" in current.dragged && time === current.dragged.item.time;
			return { ...current, time, allowed: time !== undefined && !unchanged && time > Date.now() };
		});
	};

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={pointerWithin}
			accessibility={accessibility}
			onDragStart={(event) => {
				const dragged = readDragged(event.active);
				if (dragged) setDrag({ dragged, allowed: false });
			}}
			onDragMove={update}
			onDragOver={update}
			onDragCancel={() => setDrag(null)}
			onDragEnd={(event: DragEndEvent) => {
				const dragged = readDragged(event.active);
				const time = landing(event);
				setDrag(null);
				if (!dragged || time === undefined) return;
				if ("item" in dragged && time === dragged.item.time) return;
				if (time <= Date.now()) {
					onPastDrop();
					return;
				}
				const scheduledAt = new Date(time).toISOString();
				if ("item" in dragged) onMove(dragged.item, scheduledAt);
				else onScheduleDraft(dragged.draft, scheduledAt);
			}}
		>
			{children}
			<DragOverlay dropAnimation={null}>
				{drag && (
					<CalendarEntryChipPreview
						item={previewItem(drag.dragged, drag.time)}
						display={display}
						now={now}
						allowed={drag.allowed}
					/>
				)}
			</DragOverlay>
		</DndContext>
	);
}

/** Makes a month cell or week column a place to drop entries; days before today aren't. */
export function useCalendarDrop(day: string, today: string, byTime: boolean) {
	const column = React.useRef<HTMLElement | null>(null);
	const target: DropTarget = byTime ? { day, column } : { day };
	const { setNodeRef, isOver, active } = useDroppable({
		id: `${byTime ? "week" : "month"}:${day}`,
		data: target,
		disabled: day < today,
	});
	const ref = React.useCallback(
		(element: HTMLElement | null) => {
			column.current = element;
			setNodeRef(element);
		},
		[setNodeRef],
	);
	return { ref, highlighted: isOver && active !== null };
}

/** Lets a draft row be dragged onto the calendar. */
export function useDraftDrag(draft: CalendarDraft) {
	return useDraggable({ id: `draft:${draft.collection}:${draft.id}`, data: { draft } });
}
