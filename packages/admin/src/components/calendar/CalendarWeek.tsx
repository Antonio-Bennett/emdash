import { TooltipProvider } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import {
	minutesInZone,
	timeStacks,
	type CalendarDisplay,
	type CalendarItem,
} from "../../lib/calendar.js";
import { cn } from "../../lib/utils.js";
import { HOUR_HEIGHT, useCalendarDrop } from "./CalendarDrag.js";
import { CalendarEntryChip, type CalendarSelectHandler } from "./CalendarEntry.js";
import { CalendarFilteredNotice, CalendarMorePopover } from "./CalendarMonth.js";
import { CalendarQuickCreate, type CalendarCreate } from "./CalendarQuickCreate.js";

/** A chip's 22px height (plus a 2px gap) in minutes; entries closer than this share a row. */
const CHIP_MINUTES = (24 / HOUR_HEIGHT) * 60;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** Without entries earlier in the week, the grid opens on the working day. */
const DEFAULT_SCROLL_HOUR = 8;

interface CalendarWeekProps {
	/** The week's seven days, from the locale's first weekday. */
	days: readonly string[];
	items: ReadonlyMap<string, CalendarItem[]>;
	today: string;
	now: number;
	display: CalendarDisplay;
	loading?: boolean;
	/** The last day with loaded entries, when the range has more entries than were loaded. */
	loadedThrough?: string;
	selectedKey?: string;
	onSelect?: CalendarSelectHandler;
	/** Whether the user may drag the entry to another day or time. */
	canMove?: (item: CalendarItem) => boolean;
	/** Offers a "+" on each day from today that schedules a new entry. */
	create?: CalendarCreate;
	/** Filters are on; when they hide every entry, a notice offers to clear them. */
	onClearFilters?: () => void;
}

/** A week of days on an hour grid, with each entry at its time in the site's zone. */
export function CalendarWeek({
	days,
	items,
	today,
	now,
	display,
	loading,
	loadedThrough,
	selectedKey,
	onSelect,
	canMove,
	create,
	onClearFilters,
}: CalendarWeekProps) {
	const { t } = useLingui();
	const scrollRef = React.useRef<HTMLDivElement>(null);
	const minutes = React.useCallback(
		(item: CalendarItem) => minutesInZone(item.time, display.timeZone),
		[display.timeZone],
	);
	const nowMinutes = minutesInZone(now, display.timeZone);
	const showsToday = days.includes(today);
	const filteredEmpty = Boolean(onClearFilters) && !loading && !days.some((day) => items.has(day));

	// Opens each week near the present, or on the working day or its first entry, whichever is earlier.
	const first = days[0];
	const loaded = !loading;
	React.useLayoutEffect(() => {
		const element = scrollRef.current;
		if (!element || !loaded) return;
		const earliest = Math.min(
			...days.flatMap((day) => (items.get(day) ?? []).map(minutes)),
			DEFAULT_SCROLL_HOUR * 60,
		);
		const target = showsToday ? nowMinutes - 90 : earliest - 30;
		element.scrollTop = Math.max(0, (target / 60) * HOUR_HEIGHT);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- only a new week, or its first load, scrolls
	}, [first, loaded]);

	return (
		<TooltipProvider delay={400}>
			<div className="relative min-h-[24rem] flex-1">
				<div
					ref={scrollRef}
					className="absolute inset-0 overflow-y-auto rounded-lg border border-kumo-line bg-kumo-base"
				>
					<div className="sticky top-0 z-20 grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-kumo-line bg-kumo-base">
						<span />
						{days.map((day) => (
							<div
								key={day}
								className="group/day relative flex flex-col items-center gap-0.5 border-s border-kumo-line py-2 text-xs text-kumo-subtle"
							>
								<span aria-hidden="true">{display.weekdayShort(day)}</span>
								<span
									aria-hidden="true"
									className={cn(
										"inline-flex size-7 items-center justify-center rounded-full text-base font-semibold tabular-nums",
										day === today
											? "bg-kumo-badge-red text-white"
											: day < today
												? "text-kumo-subtle"
												: "text-kumo-default",
									)}
								>
									{display.dayNumber(day)}
								</span>
								{create && day >= today && (
									<CalendarQuickCreate
										day={day}
										today={today}
										display={display}
										collections={create.collections}
										onCreated={create.onCreated}
										className="absolute end-1 top-1 opacity-0 group-hover/day:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100"
									/>
								)}
							</div>
						))}
					</div>
					<div
						className="relative grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]"
						style={{ height: HOURS.length * HOUR_HEIGHT }}
					>
						<div aria-hidden="true" className="relative">
							{HOURS.slice(1).map((hour) => (
								<span
									key={hour}
									className="absolute end-2 -translate-y-1/2 text-[11px] text-kumo-subtle tabular-nums"
									style={{ top: hour * HOUR_HEIGHT }}
								>
									{display.hourLabel(hour)}
								</span>
							))}
						</div>
						{days.map((day) => (
							<CalendarWeekDay
								key={day}
								day={day}
								items={items.get(day) ?? []}
								minutes={minutes}
								weekend={display.isWeekend(day)}
								loaded={loadedThrough === undefined || day < loadedThrough}
								today={today}
								nowMinutes={day === today ? nowMinutes : undefined}
								now={now}
								display={display}
								selectedKey={selectedKey}
								onSelect={onSelect}
								canMove={canMove}
							/>
						))}
						<div aria-hidden="true" className="pointer-events-none absolute inset-0 col-span-full">
							{HOURS.slice(1).map((hour) => (
								<div
									key={hour}
									className="absolute inset-x-0 ms-14 border-t border-kumo-line"
									style={{ top: hour * HOUR_HEIGHT }}
								/>
							))}
						</div>
					</div>
				</div>
				{filteredEmpty && onClearFilters && (
					<div className="absolute inset-0 flex items-center justify-center rounded-lg bg-radial from-kumo-base/90 via-kumo-base/60 to-kumo-base/30 p-4 backdrop-blur-xs transition-opacity duration-200 starting:opacity-0 motion-reduce:transition-none">
						<CalendarFilteredNotice
							cutOff={loadedThrough !== undefined}
							onClearFilters={onClearFilters}
						/>
					</div>
				)}
				{loading && <span className="sr-only">{t`Loading`}</span>}
			</div>
		</TooltipProvider>
	);
}

interface CalendarWeekDayProps {
	day: string;
	items: readonly CalendarItem[];
	minutes: (item: CalendarItem) => number;
	weekend: boolean;
	loaded: boolean;
	today: string;
	/** Where the now line goes, on today's column. */
	nowMinutes?: number;
	now: number;
	display: CalendarDisplay;
	selectedKey?: string;
	onSelect?: CalendarSelectHandler;
	canMove?: (item: CalendarItem) => boolean;
}

function CalendarWeekDay({
	day,
	items,
	minutes,
	weekend,
	loaded,
	today,
	nowMinutes,
	now,
	display,
	selectedKey,
	onSelect,
	canMove,
}: CalendarWeekDayProps) {
	const { t } = useLingui();
	const drop = useCalendarDrop(day, today, true);
	const stacks = React.useMemo(() => timeStacks(items, minutes, CHIP_MINUTES), [items, minutes]);

	return (
		<div
			ref={drop.ref}
			className={cn(
				"relative border-s border-kumo-line",
				weekend && "bg-kumo-elevated",
				drop.highlighted && "bg-kumo-tint",
			)}
		>
			{items.length > 0 && (
				<ul aria-label={display.fullDate(day)}>
					{stacks.map((stack) => {
						const [first] = stack;
						if (!first) return null;
						// A stack shows its selected entry, so the selection stays visible.
						const shown = stack.find((item) => item.key === selectedKey) ?? first;
						return (
							<li
								key={first.key}
								className="absolute inset-x-0 z-10 flex min-w-0 gap-0.5 px-0.5"
								style={{ top: (minutes(first) / 60) * HOUR_HEIGHT }}
							>
								<span className="grid min-w-0 flex-1">
									<CalendarEntryChip
										item={shown}
										display={display}
										now={now}
										selected={shown.key === selectedKey}
										onSelect={onSelect}
										movable={canMove?.(shown)}
									/>
								</span>
								{stack.length > 1 && (
									<span className="shrink-0">
										<CalendarMorePopover
											day={day}
											items={stack}
											hidden={stack.length - 1}
											display={display}
											now={now}
											selectedKey={selectedKey}
											onSelect={onSelect}
										/>
									</span>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{!loaded && items.length === 0 && (
				<p className="px-1 pt-1 text-xs text-kumo-inactive">{t`Not loaded`}</p>
			)}
			{nowMinutes !== undefined && (
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-0 z-10 flex -translate-y-1/2 items-center"
					style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
				>
					<span className="-ms-1 size-2 shrink-0 rounded-full bg-kumo-danger" />
					<span className="h-[1.5px] flex-1 bg-kumo-danger" />
				</div>
			)}
		</div>
	);
}
