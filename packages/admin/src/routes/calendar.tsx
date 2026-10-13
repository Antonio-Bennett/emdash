/**
 * Calendar page
 *
 * Published and scheduled entries across collections, placed by day in the
 * site's time zone.
 */

import { Banner, Button, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { FileDashed, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import * as React from "react";

import { CalendarAgenda } from "../components/calendar/CalendarAgenda.js";
import { CalendarDrafts } from "../components/calendar/CalendarDrafts.js";
import { CalendarDragProvider, type CalendarDraft } from "../components/calendar/CalendarDrag.js";
import { CalendarEntryPanel } from "../components/calendar/CalendarEntryPanel.js";
import { CalendarFilters } from "../components/calendar/CalendarFilters.js";
import { CalendarMonth } from "../components/calendar/CalendarMonth.js";
import type { CalendarCreate } from "../components/calendar/CalendarQuickCreate.js";
import { CalendarToolbar } from "../components/calendar/CalendarToolbar.js";
import { CalendarWeek } from "../components/calendar/CalendarWeek.js";
import { getMutationError } from "../components/DialogError.js";
import { visibleCollectionEntries } from "../components/Sidebar.js";
import {
	CALENDAR_MAX_ENTRIES,
	calendarEntryKey,
	calendarQueryOptions,
} from "../lib/api/calendar.js";
import { ApiResponseError, fetchManifest, type AdminManifest } from "../lib/api/client.js";
import { scheduleContent, unscheduleContent } from "../lib/api/content.js";
import { useCurrentUser } from "../lib/api/current-user.js";
import {
	canPublishEntry,
	createCalendarDisplay,
	dayKeyInZone,
	dayKeyToUTC,
	fetchRange,
	filterItems,
	groupByDay,
	isCalendarState,
	isMonthKey,
	monthGridDays,
	readList,
	shiftDay,
	shiftMonth,
	toCalendarItems,
	toListParam,
	weekDays,
	type CalendarFilterValues,
	type CalendarItem,
	type CalendarSearch,
	type CalendarView,
} from "../lib/calendar.js";
import { cn } from "../lib/utils.js";
import { useDateLocale } from "../locales/date-locale.js";

const REFRESH_MS = 60_000;
/** Below this width the month grid's cells get too narrow, so the calendar uses its compact layout. */
const COMPACT_WIDTH = 640;
/**
 * Extra room needed to leave the compact layout. A scrollbar that appears
 * with the taller grid narrows the page, which would otherwise flip it back.
 */
const COMPACT_SLACK = 24;
/** From this width the side panel sits beside the calendar instead of over it. */
const DOCK_WIDTH = 1000;
const NO_LOCALES: string[] = [];

/**
 * Whether the element is narrower than `width`. The sidebar takes part of the
 * viewport, so the calendar measures itself; the measurement runs before paint.
 */
function useNarrow(ref: React.RefObject<HTMLElement | null>, width: number): boolean {
	const [narrow, setNarrow] = React.useState(() => window.innerWidth < width);
	React.useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () =>
			setNarrow((wasNarrow) => element.clientWidth < width + (wasNarrow ? COMPACT_SLACK : 0));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref, width]);
	return narrow;
}

/** The current time, updated at each minute boundary. */
function useNow(): number {
	const [now, setNow] = React.useState(() => Date.now());
	React.useEffect(() => {
		let timer: ReturnType<typeof setTimeout>;
		const tick = () => {
			timer = setTimeout(
				() => {
					setNow(Date.now());
					tick();
				},
				60_000 - (Date.now() % 60_000),
			);
		};
		tick();
		return () => clearTimeout(timer);
	}, []);
	return now;
}

/** Shortcuts don't fire while typing or inside menus and lists that use letter keys themselves. */
const SHORTCUT_IGNORE =
	"input, textarea, select, [contenteditable], [role=menu], [role=listbox], [role=combobox]";

/**
 * Runs the handler for a letter key pressed on its own, by physical key so
 * shortcuts work in every keyboard layout.
 */
function useShortcuts(handlers: Partial<Record<string, () => void>>) {
	const latest = React.useRef(handlers);
	React.useLayoutEffect(() => {
		latest.current = handlers;
	});
	React.useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.repeat) return;
			if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
			if (event.target instanceof Element && event.target.closest(SHORTCUT_IGNORE)) return;
			const handler = latest.current[event.code];
			if (!handler) return;
			event.preventDefault();
			handler();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
}

export function CalendarPage() {
	const { data: manifest } = useQuery({ queryKey: ["manifest"], queryFn: fetchManifest });
	if (!manifest) return null;
	return <Calendar manifest={manifest} />;
}

function Calendar({ manifest }: { manifest: AdminManifest }) {
	const { t, i18n } = useLingui();
	const search = useSearch({ from: "/_admin/calendar" });
	const navigate = useNavigate();
	const router = useRouter();
	const queryClient = useQueryClient();
	const { data: user } = useCurrentUser();
	const now = useNow();
	const containerRef = React.useRef<HTMLDivElement>(null);
	const compact = useNarrow(containerRef, COMPACT_WIDTH);
	const docked = !useNarrow(containerRef, DOCK_WIDTH);
	const [dock, setDock] = React.useState<HTMLDivElement | null>(null);

	const collections = React.useMemo(
		() =>
			visibleCollectionEntries(manifest.collections).map(([slug, collection]) => ({
				slug,
				label: collection.label,
				icon: collection.icon,
			})),
		[manifest.collections],
	);
	const collectionOrder = React.useMemo(
		() => collections.map((collection) => collection.slug),
		[collections],
	);
	const urlPatterns = React.useMemo(
		() =>
			Object.fromEntries(
				Object.entries(manifest.collections).map(([slug, collection]) => [
					slug,
					collection.urlPattern,
				]),
			),
		[manifest.collections],
	);
	const locales = manifest.i18n?.locales ?? NO_LOCALES;
	const showLocale = locales.length > 1;
	const display = React.useMemo(
		() =>
			createCalendarDisplay({
				locale: i18n.locale,
				timeZone: manifest.timezone,
				collections,
				showLocale,
			}),
		[i18n.locale, manifest.timezone, collections, showLocale],
	);

	const today = dayKeyInZone(now, display.timeZone);
	const currentMonth = today.slice(0, 7);
	const dateLocale = useDateLocale();
	const weekStartsOn = dateLocale.options?.weekStartsOn ?? 0;
	const requestedView = search.view ?? (compact ? "agenda" : "month");
	// Phones have no room for seven columns of times, so a week link opens the agenda.
	const view: CalendarView = compact && requestedView === "week" ? "agenda" : requestedView;
	// A week view without its own day opens on the shown month's first week, or this week.
	const weekAnchor =
		search.week ?? (search.month && search.month !== currentMonth ? `${search.month}-01` : today);
	const weekGrid = React.useMemo(
		() => weekDays(weekAnchor, weekStartsOn),
		[weekAnchor, weekStartsOn],
	);
	// A week belongs to the month of its middle day.
	const weekMonth = weekGrid[3]?.slice(0, 7) ?? currentMonth;
	const month = search.week ? weekMonth : (search.month ?? currentMonth);
	const gridDays = React.useMemo(() => monthGridDays(month, weekStartsOn), [month, weekStartsOn]);
	const range = React.useMemo(
		() => fetchRange(view === "week" ? weekGrid : gridDays),
		[view, weekGrid, gridDays],
	);

	// Values that match no current option (a deleted collection in a shared link) are ignored.
	const filters: CalendarFilterValues = React.useMemo(
		() => ({
			collections: readList(search.collections).filter((slug) => collectionOrder.includes(slug)),
			locales: readList(search.locales).filter((locale) => locales.includes(locale)),
			states: readList(search.states).filter(isCalendarState),
		}),
		[search.collections, search.locales, search.states, collectionOrder, locales],
	);
	const filtered = filters.collections.length + filters.locales.length + filters.states.length > 0;
	const rangeHasNow = now >= Date.parse(range.from) && now < Date.parse(range.to);

	const calendar = useQuery({
		...calendarQueryOptions(range.from, range.to),
		staleTime: 0,
		refetchInterval: (query) =>
			rangeHasNow && query.state.status !== "error" ? REFRESH_MS : false,
	});

	const items = React.useMemo(
		() =>
			calendar.data
				? toCalendarItems(calendar.data.items, {
						timeZone: display.timeZone,
						loadedAt: calendar.dataUpdatedAt,
						collectionOrder,
					})
				: [],
		[calendar.data, calendar.dataUpdatedAt, display.timeZone, collectionOrder],
	);
	const visibleItems = React.useMemo(() => filterItems(items, filters), [items, filters]);
	// Pages load oldest first, so a truncated range is complete before its last loaded day.
	const loadedThrough = calendar.data?.truncated ? items.at(-1)?.day : undefined;
	const days = React.useMemo(() => groupByDay(visibleItems), [visibleItems]);
	const unfilteredDays = React.useMemo(
		() => (filtered ? groupByDay(items) : days),
		[filtered, items, days],
	);

	const updateSearch = (patch: Partial<CalendarSearch>, options?: { push?: boolean }) => {
		void navigate({
			to: "/calendar",
			search: (previous) => ({ ...previous, ...patch }),
			replace: !options?.push,
		});
	};

	// Opening the panel adds a history entry, so Back closes it; switching entries replaces it.
	const selectedKey = search.entry;
	const searchWithoutEntry = JSON.stringify({ ...search, entry: undefined });
	// The search the panel's own history entry was added over; closing goes back to it when nothing else changed.
	const pushedFromRef = React.useRef<string | null>(null);
	const returnFocusRef = React.useRef<HTMLElement | null>(null);
	React.useEffect(() => {
		if (selectedKey === undefined) pushedFromRef.current = null;
	}, [selectedKey]);
	const openKey = (key: string, element: HTMLElement | null) => {
		returnFocusRef.current = element;
		if (selectedKey === undefined) pushedFromRef.current = searchWithoutEntry;
		updateSearch({ entry: key }, { push: selectedKey === undefined });
	};
	const openEntry = (item: CalendarItem, element: HTMLElement) => openKey(item.key, element);
	const closeEntry = () => {
		const pushedFrom = pushedFromRef.current;
		pushedFromRef.current = null;
		if (pushedFrom === searchWithoutEntry) router.history.back();
		else updateSearch({ entry: undefined });
	};
	// A refetch after an action can briefly lack the entry, so the panel keeps the last copy until data settles.
	const found = selectedKey ? items.find((item) => item.key === selectedKey) : undefined;
	const [lastSelected, setLastSelected] = React.useState<CalendarItem>();
	if (found && found !== lastSelected) setLastSelected(found);
	const selectedItem = found ?? (lastSelected?.key === selectedKey ? lastSelected : undefined);
	const settled = Boolean(calendar.data) && !calendar.isFetching;
	const entryMissing = Boolean(selectedKey) && !found && settled;
	React.useEffect(() => {
		if (!entryMissing) return;
		void navigate({
			to: "/calendar",
			search: (previous) => ({ ...previous, entry: undefined }),
			replace: true,
		});
	}, [entryMissing, navigate]);
	const goToMonth = (next: string | undefined) => {
		if (next === undefined || isMonthKey(next)) updateSearch({ month: next });
	};
	/** Shows the week containing `day`, or this week. */
	const goToWeek = (day: string | undefined) => {
		const shown = day && weekDays(day, weekStartsOn);
		updateSearch({
			week: shown && !shown.includes(today) ? shown[0] : undefined,
			month: undefined,
		});
	};
	const changeView = (next: CalendarView) => {
		updateSearch(
			search.week
				? { view: next, week: undefined, month: weekMonth === currentMonth ? undefined : weekMonth }
				: { view: next },
		);
	};
	const setFilters = (patch: Partial<CalendarFilterValues>) => {
		updateSearch({
			...(patch.collections && { collections: toListParam(patch.collections) }),
			...(patch.locales && { locales: toListParam(patch.locales) }),
			...(patch.states && { states: toListParam(patch.states) }),
		});
	};
	const filterTriggerRef = React.useRef<HTMLButtonElement>(null);
	// The notices offering this unmount once it runs, so focus moves to the Filter menu.
	const clearFilters = () => {
		setFilters({ collections: [], locales: [], states: [] });
		filterTriggerRef.current?.focus();
	};
	const prefetch = (targetDays: readonly string[]) => {
		const targetRange = fetchRange(targetDays);
		void queryClient.prefetchQuery({
			...calendarQueryOptions(targetRange.from, targetRange.to),
			staleTime: REFRESH_MS,
		});
	};
	const prefetchMonth = (target: string) => {
		if (isMonthKey(target)) prefetch(monthGridDays(target, weekStartsOn));
	};
	const weekStart = weekGrid[0] ?? today;
	const period =
		view === "week"
			? {
					title: display.weekTitle(weekStart, weekGrid[6] ?? weekStart),
					zoneTime: dayKeyToUTC(weekGrid[3] ?? weekStart) + 12 * 3_600_000,
					previous: () => goToWeek(shiftDay(weekStart, -7)),
					next: () => goToWeek(shiftDay(weekStart, 7)),
					today: () => goToWeek(undefined),
					previewPrevious: () => prefetch(weekDays(shiftDay(weekStart, -7), weekStartsOn)),
					previewNext: () => prefetch(weekDays(shiftDay(weekStart, 7), weekStartsOn)),
				}
			: {
					title: display.monthTitle(month),
					zoneTime: dayKeyToUTC(`${month}-15`) + 12 * 3_600_000,
					previous: () => goToMonth(shiftMonth(month, -1)),
					next: () => goToMonth(shiftMonth(month, 1)),
					today: () => goToMonth(undefined),
					previewPrevious: () => prefetchMonth(shiftMonth(month, -1)),
					previewNext: () => prefetchMonth(shiftMonth(month, 1)),
				};

	const toastManager = useKumoToastManager();
	const canMove = React.useCallback(
		(item: CalendarItem) => item.kind === "scheduled" && canPublishEntry(user, item.authorId),
		[user],
	);
	const refreshContent = (collection: string) => {
		void queryClient.invalidateQueries({ queryKey: ["calendar"] });
		void queryClient.invalidateQueries({ queryKey: ["content", collection] });
		void queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
	};
	const move = useMutation({
		mutationFn: ({
			item,
			scheduledAt,
		}: {
			item: CalendarItem;
			scheduledAt: string;
			undo?: boolean;
		}) => scheduleContent(item.collection, item.id, scheduledAt, { locale: item.locale }),
		onMutate: async ({ item, scheduledAt }) => {
			const { queryKey } = calendarQueryOptions(range.from, range.to);
			await queryClient.cancelQueries({ queryKey: ["calendar"] });
			const previous = queryClient.getQueryData(queryKey);
			queryClient.setQueryData(queryKey, (data) =>
				data
					? {
							...data,
							items: data.items.map((entry) =>
								calendarEntryKey(entry) === item.key ? { ...entry, at: scheduledAt } : entry,
							),
						}
					: data,
			);
			return { queryKey, previous };
		},
		onError: (moveError, _variables, context) => {
			if (context) queryClient.setQueryData(context.queryKey, context.previous);
			toastManager.add({
				title: t`Could not reschedule`,
				description: getMutationError(moveError),
				type: "error",
			});
		},
		onSuccess: (_changed, { item, scheduledAt, undo }) => {
			const title = item.title;
			const when = display.formatDateTime(Date.parse(scheduledAt));
			toastManager.add({
				title: t`Rescheduled`,
				description: t`${title} now goes live ${when}.`,
				// A time that has passed can't be scheduled again.
				actions:
					undo || item.time <= Date.now()
						? undefined
						: [
								{
									children: t`Undo`,
									onClick: () => move.mutate({ item, scheduledAt: item.at, undo: true }),
								},
							],
			});
		},
		onSettled: (_changed, _error, { item }) => refreshContent(item.collection),
	});
	// Scheduling a new entry takes publishing your own.
	const createOptions = canPublishEntry(user, user?.id)
		? visibleCollectionEntries(manifest.collections).flatMap(([slug, collection]) => {
				const titleField =
					collection.titleField ?? ["title", "name"].find((field) => field in collection.fields);
				return collection.quickCreate === false || !titleField
					? []
					: [{ slug, label: collection.labelSingular || collection.label, titleField }];
			})
		: [];
	const create: CalendarCreate | undefined =
		createOptions.length > 0
			? {
					collections: createOptions,
					onCreated: async ({ collection, id, trigger }) => {
						void queryClient.invalidateQueries({ queryKey: ["content", collection] });
						void queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
						// The panel opens once the calendar has the new entry.
						await queryClient.invalidateQueries({ queryKey: ["calendar"] });
						openKey(calendarEntryKey({ collection, id, kind: "scheduled" }), trigger);
					},
				}
			: undefined;
	// Unscheduled drafts sit beside the calendar, so they need the docked layout.
	const [draftsOpen, setDraftsOpen] = React.useState(false);
	const canSchedule = canPublishEntry(user, user?.id);
	const showDrafts = docked && canSchedule && draftsOpen;
	const draftCollections = visibleCollectionEntries(manifest.collections).map(
		([slug, collection]) => ({ slug, titleField: collection.titleField }),
	);
	const scheduleDraft = useMutation({
		mutationFn: ({ draft, scheduledAt }: { draft: CalendarDraft; scheduledAt: string }) =>
			scheduleContent(draft.collection, draft.id, scheduledAt, { locale: draft.locale }),
		onSuccess: (_changed, { draft, scheduledAt }) => {
			const title = draft.title;
			const when = display.formatDateTime(Date.parse(scheduledAt));
			toastManager.add({
				title: t`Scheduled`,
				description: t`${title} goes live ${when}.`,
				actions: [
					{
						children: t`Undo`,
						onClick: () =>
							void unscheduleContent(draft.collection, draft.id, { locale: draft.locale })
								.catch((undoError: unknown) =>
									toastManager.add({
										title: t`Could not remove the schedule`,
										description: getMutationError(undoError),
										type: "error",
									}),
								)
								.finally(() => refreshContent(draft.collection)),
					},
				],
			});
		},
		onError: (scheduleError) => {
			toastManager.add({
				title: t`Could not schedule`,
				description: getMutationError(scheduleError),
				type: "error",
			});
		},
		onSettled: (_changed, _error, { draft }) => refreshContent(draft.collection),
	});
	const rejectPastDrop = () => {
		toastManager.add({
			title: t`That time has passed`,
			description: t`Drop the entry on a later day or time.`,
			type: "error",
		});
	};

	const error = calendar.error;
	const errorMessage =
		error instanceof ApiResponseError
			? error.code === "FORBIDDEN"
				? t`You don't have permission to view the calendar.`
				: error.message
			: t`Check your connection and try again.`;
	const maxEntries = new Intl.NumberFormat(i18n.locale).format(CALENDAR_MAX_ENTRIES);
	const cutOffDay = loadedThrough && display.monthDay(loadedThrough);

	const views: CalendarView[] = compact ? ["month", "agenda"] : ["month", "week", "agenda"];
	useShortcuts({
		KeyT: period.today,
		KeyJ: period.next,
		KeyK: period.previous,
		KeyM: () => changeView("month"),
		KeyW: compact ? undefined : () => changeView("week"),
		KeyA: () => changeView("agenda"),
	});

	return (
		<div ref={containerRef} className="flex h-full min-w-0">
			<CalendarDragProvider
				display={display}
				now={now}
				onMove={(item, scheduledAt) => move.mutate({ item, scheduledAt })}
				onScheduleDraft={(draft, scheduledAt) => scheduleDraft.mutate({ draft, scheduledAt })}
				onPastDrop={rejectPastDrop}
			>
				<div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
					<h1 className="sr-only">{t`Calendar`}</h1>
					<CalendarToolbar
						title={period.title}
						display={display}
						zoneTime={period.zoneTime}
						loading={calendar.isPending && calendar.isFetching}
						view={view}
						views={views}
						onViewChange={changeView}
						onPrevious={period.previous}
						onNext={period.next}
						onToday={period.today}
						onPreviewPrevious={period.previewPrevious}
						onPreviewNext={period.previewNext}
						tools={
							<>
								{docked && canSchedule && (
									<Button
										variant="secondary"
										className="shrink-0 text-sm"
										icon={<FileDashed aria-hidden="true" className="size-4" />}
										aria-pressed={draftsOpen}
										onClick={() => setDraftsOpen(!draftsOpen)}
									>
										{t`Drafts`}
									</Button>
								)}
								<CalendarFilters
									display={display}
									collections={collections}
									locales={locales}
									value={filters}
									onChange={setFilters}
									triggerRef={filterTriggerRef}
								/>
							</>
						}
					/>

					{error && (
						<Banner
							variant="error"
							icon={<WarningCircle aria-hidden="true" />}
							title={t`Could not load the calendar`}
							description={errorMessage}
							action={
								<Button variant="secondary" size="sm" onClick={() => void calendar.refetch()}>
									{t`Retry`}
								</Button>
							}
						/>
					)}
					{calendar.data?.truncated && (
						<Banner
							variant="alert"
							title={t`This range has more than ${maxEntries} entries`}
							description={
								cutOffDay
									? t`The calendar shows the first ${maxEntries}, which end on ${cutOffDay}.`
									: t`The calendar shows the first ${maxEntries}.`
							}
						/>
					)}

					{!(error && !calendar.data) &&
						(view === "week" ? (
							<CalendarWeek
								days={weekGrid}
								items={days}
								today={today}
								now={now}
								display={display}
								loading={!calendar.data}
								loadedThrough={loadedThrough}
								selectedKey={selectedKey}
								onSelect={openEntry}
								canMove={canMove}
								create={create}
								onClearFilters={filtered ? clearFilters : undefined}
							/>
						) : view === "month" ? (
							<CalendarMonth
								month={month}
								gridDays={gridDays}
								days={days}
								unfilteredDays={unfilteredDays}
								today={today}
								now={now}
								display={display}
								loading={!calendar.data}
								loadedThrough={loadedThrough}
								compact={compact}
								selectedKey={selectedKey}
								onSelect={openEntry}
								canMove={canMove}
								create={create}
								onMonthChange={goToMonth}
								onClearFilters={filtered ? clearFilters : undefined}
							/>
						) : (
							<div className="min-h-0 flex-1 overflow-y-auto">
								<CalendarAgenda
									key={month}
									month={month}
									days={days}
									today={today}
									now={now}
									display={display}
									loading={!calendar.data}
									loadedThrough={loadedThrough}
									onClearFilters={filtered ? clearFilters : undefined}
									selectedKey={selectedKey}
									onSelect={openEntry}
								/>
							</div>
						))}
				</div>

				{docked && (
					<div
						ref={setDock}
						className={cn(
							"relative h-full shrink-0 overflow-hidden border-kumo-line transition-[width] duration-200 ease-out motion-reduce:transition-none",
							selectedItem || showDrafts ? "w-96 border-s" : "w-0",
						)}
					>
						{showDrafts && (
							<CalendarDrafts
								collections={draftCollections}
								display={display}
								now={now}
								user={user}
								onClose={() => setDraftsOpen(false)}
							/>
						)}
					</div>
				)}
			</CalendarDragProvider>
			{(!docked || dock) && (
				<CalendarEntryPanel
					item={selectedItem}
					dock={docked ? dock : null}
					display={display}
					now={now}
					compact={compact}
					i18n={manifest.i18n}
					urlPatterns={urlPatterns}
					user={user}
					returnFocus={returnFocusRef}
					onClose={closeEntry}
					onRescheduled={(_item, scheduledAt) => {
						const day = dayKeyInZone(Date.parse(scheduledAt), display.timeZone);
						if (view === "week") {
							if (!weekGrid.includes(day)) goToWeek(day);
						} else if (day.slice(0, 7) !== month) {
							goToMonth(day.slice(0, 7));
						}
					}}
				/>
			)}
		</div>
	);
}
