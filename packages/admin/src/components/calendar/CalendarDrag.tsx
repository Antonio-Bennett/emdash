import {
	DndContext,
	DragOverlay,
	PointerSensor,
	pointerWithin,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
	type DragEndEvent,
	type DragMoveEvent,
	type DragStartEvent,
} from "@dnd-kit/core";
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

type Dragged = { item: CalendarItem } | { draft: CalendarDraft };

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

function readDragged(event: DragStartEvent | DragMoveEvent): Dragged | undefined {
	const data = event.active.data.current;
	if (data?.item) return { item: data.item as CalendarItem };
	if (data?.draft) return { draft: data.draft as CalendarDraft };
	return undefined;
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
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
	const [drag, setDrag] = React.useState<DragState | null>(null);

	const landing = (event: DragMoveEvent): number | undefined => {
		const dragged = readDragged(event);
		const target = event.over?.data.current as DropTarget | undefined;
		if (!dragged || !target) return undefined;
		const column = target.column?.current;
		const dropped = event.active.rect.current.translated;
		if (!column || !dropped) {
			const minutes =
				"item" in dragged ? minutesInZone(dragged.item.time, display.timeZone) : DRAFT_DAY_MINUTES;
			return zonedInstant(target.day, minutes, display.timeZone);
		}
		// Both rects are measured now, so scrolling the grid during the drag is accounted for.
		const offset = dropped.top - column.getBoundingClientRect().top;
		const snapped = Math.round(((offset / HOUR_HEIGHT) * 60) / SNAP_MINUTES) * SNAP_MINUTES;
		return zonedInstant(
			target.day,
			Math.min(Math.max(snapped, 0), 24 * 60 - SNAP_MINUTES),
			display.timeZone,
		);
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
			onDragStart={(event) => {
				const dragged = readDragged(event);
				if (dragged) setDrag({ dragged, allowed: false });
			}}
			onDragMove={update}
			onDragOver={update}
			onDragCancel={() => setDrag(null)}
			onDragEnd={(event: DragEndEvent) => {
				const dragged = readDragged(event);
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
