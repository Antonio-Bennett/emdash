import {
	DndContext,
	DragOverlay,
	PointerSensor,
	pointerWithin,
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

interface DropTarget {
	day: string;
	/** Week columns also move the time by how far the entry was dragged. */
	byTime: boolean;
}

interface DragState {
	item: CalendarItem;
	/** Where the entry would land if dropped now. */
	time: number;
	allowed: boolean;
}

function droppedItem(event: DragStartEvent | DragMoveEvent): CalendarItem | undefined {
	const data: unknown = event.active.data.current;
	return data && typeof data === "object" && "item" in data
		? (data.item as CalendarItem)
		: undefined;
}

interface CalendarDragProviderProps {
	display: CalendarDisplay;
	now: number;
	/** Called with the new time when an entry is dropped on another day or time. */
	onMove: (item: CalendarItem, scheduledAt: string) => void;
	/** Called when an entry is dropped on a time that has passed. */
	onPastDrop: () => void;
	children: React.ReactNode;
}

/** Lets scheduled entries be dragged onto another day in the month, or another time in the week. */
export function CalendarDragProvider({
	display,
	now,
	onMove,
	onPastDrop,
	children,
}: CalendarDragProviderProps) {
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
	const [drag, setDrag] = React.useState<DragState | null>(null);

	const landing = (event: DragMoveEvent): number | undefined => {
		const item = droppedItem(event);
		const target = event.over?.data.current as DropTarget | undefined;
		if (!item || !target) return undefined;
		const minutes = minutesInZone(item.time, display.timeZone);
		if (!target.byTime) return zonedInstant(target.day, minutes, display.timeZone);
		// The delta includes any scrolling of the grid during the drag.
		const moved = minutes + (event.delta.y / HOUR_HEIGHT) * 60;
		const snapped = Math.round(moved / SNAP_MINUTES) * SNAP_MINUTES;
		return zonedInstant(
			target.day,
			Math.min(Math.max(snapped, 0), 24 * 60 - SNAP_MINUTES),
			display.timeZone,
		);
	};

	const update = (event: DragMoveEvent) => {
		const time = landing(event);
		setDrag((current) =>
			current
				? {
						...current,
						time: time ?? current.item.time,
						allowed: time !== undefined && time !== current.item.time && time > Date.now(),
					}
				: current,
		);
	};

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={pointerWithin}
			onDragStart={(event) => {
				const item = droppedItem(event);
				if (item) setDrag({ item, time: item.time, allowed: false });
			}}
			onDragMove={update}
			onDragOver={update}
			onDragCancel={() => setDrag(null)}
			onDragEnd={(event: DragEndEvent) => {
				const item = droppedItem(event);
				const time = landing(event);
				setDrag(null);
				if (!item || time === undefined || time === item.time) return;
				if (time <= Date.now()) {
					onPastDrop();
					return;
				}
				onMove(item, new Date(time).toISOString());
			}}
		>
			{children}
			<DragOverlay dropAnimation={null}>
				{drag && (
					<CalendarEntryChipPreview
						item={{ ...drag.item, time: drag.time }}
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
	const target: DropTarget = { day, byTime };
	const { setNodeRef, isOver, active } = useDroppable({
		id: `${byTime ? "week" : "month"}:${day}`,
		data: target,
		disabled: day < today,
	});
	return { ref: setNodeRef, highlighted: isOver && active !== null };
}
