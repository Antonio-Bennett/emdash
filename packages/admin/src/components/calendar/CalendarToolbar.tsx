import { Button, Loader, Tabs } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Columns, GridFour, Globe, ListBullets } from "@phosphor-icons/react";
import type * as React from "react";

import type { CalendarDisplay, CalendarView } from "../../lib/calendar.js";
import { CaretNext, CaretPrev } from "../ArrowIcons.js";

interface CalendarToolbarProps {
	title: string;
	display: CalendarDisplay;
	/** An instant in the shown range, for zone names that change with daylight saving time. */
	zoneTime: number;
	loading: boolean;
	view: CalendarView;
	views: readonly CalendarView[];
	onViewChange: (view: CalendarView) => void;
	onPrevious: () => void;
	onNext: () => void;
	onToday: () => void;
	/** Called when the pointer or focus reaches a period button, before it is pressed. */
	onPreviewPrevious?: () => void;
	onPreviewNext?: () => void;
	/** Filters and other tools after the view switcher. */
	tools?: React.ReactNode;
}

const VIEW_ICONS = { month: GridFour, week: Columns, agenda: ListBullets } as const;

export function CalendarToolbar({
	title,
	display,
	zoneTime,
	loading,
	view,
	views,
	onViewChange,
	onPrevious,
	onNext,
	onToday,
	onPreviewPrevious,
	onPreviewNext,
	tools,
}: CalendarToolbarProps) {
	const { t } = useLingui();
	const siteZone = display.zoneShortName(zoneTime);
	const viewerZone = display.viewerZoneShortName(zoneTime);
	const showViewerZone = display.viewerZoneDiffers && viewerZone !== siteZone;
	const zoneName = display.zoneName;
	const viewerZoneName = display.viewerZoneName;
	const zoneDescription = showViewerZone
		? t`Times are in ${zoneName}. Your browser uses ${viewerZoneName}.`
		: t`Times are in ${zoneName}.`;
	const viewLabels: Record<CalendarView, string> = {
		month: t`Month`,
		week: t`Week`,
		agenda: t`Agenda`,
	};
	const period = view === "week" ? "week" : "month";

	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-3">
			<div className="grid min-w-0 flex-1">
				<h2 className="truncate text-xl leading-7 font-semibold text-kumo-default">{title}</h2>
				<p
					title={zoneDescription}
					className="flex min-w-0 items-center gap-1 text-xs text-kumo-subtle tabular-nums"
				>
					<Globe aria-hidden="true" className="size-3.5 shrink-0" />
					<span aria-hidden="true" className="truncate">
						{showViewerZone ? t`${siteZone} · Your time: ${viewerZone}` : siteZone}
					</span>
					<span className="sr-only">{zoneDescription}</span>
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-1">
				{loading && <Loader size="sm" aria-label={t`Loading`} className="me-1" />}
				<Button variant="secondary" onClick={onToday} aria-keyshortcuts="T">
					{t`Today`}
				</Button>
				<Button
					variant="ghost"
					shape="square"
					aria-label={period === "week" ? t`Previous week` : t`Previous month`}
					aria-keyshortcuts="K"
					icon={<CaretPrev aria-hidden="true" />}
					onClick={onPrevious}
					onPointerEnter={onPreviewPrevious}
					onFocus={onPreviewPrevious}
				/>
				<Button
					variant="ghost"
					shape="square"
					aria-label={period === "week" ? t`Next week` : t`Next month`}
					aria-keyshortcuts="J"
					icon={<CaretNext aria-hidden="true" />}
					onClick={onNext}
					onPointerEnter={onPreviewNext}
					onFocus={onPreviewNext}
				/>
			</div>
			<div className="flex min-w-0 items-center gap-2 max-sm:w-full">
				<Tabs
					value={view}
					onValueChange={(value) => {
						const next = views.find((option) => option === value);
						if (next) onViewChange(next);
					}}
					tabs={views.map((option) => {
						const ViewIcon = VIEW_ICONS[option];
						return {
							value: option,
							className: "flex-1 justify-center text-sm sm:flex-none",
							label: (
								<span className="flex items-center gap-1.5">
									<ViewIcon
										className="size-4 shrink-0"
										weight={view === option ? "fill" : "regular"}
										aria-hidden="true"
									/>
									{viewLabels[option]}
								</span>
							),
						};
					})}
					className="min-w-0 flex-1 sm:flex-none"
					listClassName="w-full"
				/>
				{tools}
			</div>
		</div>
	);
}
