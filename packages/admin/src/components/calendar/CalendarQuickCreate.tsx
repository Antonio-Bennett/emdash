import { Button, Input, Popover, Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Plus } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { createContent, scheduleContent } from "../../lib/api/content.js";
import {
	dayKeyToUTC,
	minutesInZone,
	zonedInstant,
	type CalendarDisplay,
} from "../../lib/calendar.js";
import { cn } from "../../lib/utils.js";
import { getMutationError } from "../DialogError.js";

export interface QuickCreateCollection {
	slug: string;
	label: string;
	/** The field new entries take their title in. */
	titleField: string;
	/** The values new entries start with, as in the editor. */
	defaults: Record<string, unknown>;
}

/** The collections a "+" can schedule into, and what happens once it has. */
export interface CalendarCreate {
	collections: readonly QuickCreateCollection[];
	onCreated: (created: QuickCreated) => void | Promise<void>;
}

export interface QuickCreated {
	collection: string;
	id: string;
	/** Where focus goes when the new entry's panel closes. */
	trigger: HTMLElement | null;
}

interface CalendarQuickCreateProps {
	day: string;
	today: string;
	display: CalendarDisplay;
	collections: readonly QuickCreateCollection[];
	onCreated: (created: QuickCreated) => void | Promise<void>;
	className?: string;
}

const WORKDAY_START = 9 * 60;
const LAST_COLLECTION_KEY = "emdash:calendar:quick-create-collection";

function lastCollection(collections: readonly QuickCreateCollection[]): string {
	let saved: string | null = null;
	try {
		saved = localStorage.getItem(LAST_COLLECTION_KEY);
	} catch {
		// Storage can be unavailable, such as in some private windows.
	}
	return collections.find((option) => option.slug === saved)?.slug ?? collections[0]?.slug ?? "";
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** 9:00, or on today the next whole hour. */
function defaultTime(day: string, today: string, timeZone: string): string {
	const minutes =
		day === today
			? Math.min(Math.floor(minutesInZone(Date.now(), timeZone) / 60 + 1) * 60, 23 * 60 + 45)
			: WORKDAY_START;
	return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** A "+" that schedules a new draft on the day, with a title, collection, and time. */
export function CalendarQuickCreate({
	day,
	today,
	display,
	collections,
	onCreated,
	className,
}: CalendarQuickCreateProps) {
	const { t } = useLingui();
	const [open, setOpen] = React.useState(false);
	const triggerRef = React.useRef<HTMLButtonElement>(null);
	const date = display.fullDate(day);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				render={
					<Button
						ref={triggerRef}
						variant="ghost"
						shape="square"
						size="sm"
						aria-label={t`Schedule an entry on ${date}`}
						icon={<Plus aria-hidden="true" />}
						className={cn("size-5 text-kumo-subtle", className)}
					/>
				}
			/>
			<Popover.Content className="w-72 max-w-[calc(100vw-2rem)] p-3" align="start">
				{open && (
					<QuickCreateForm
						day={day}
						today={today}
						display={display}
						collections={collections}
						onCancel={() => setOpen(false)}
						onCreated={async (created) => {
							setOpen(false);
							await onCreated({ ...created, trigger: triggerRef.current });
						}}
					/>
				)}
			</Popover.Content>
		</Popover>
	);
}

function QuickCreateForm({
	day,
	today,
	display,
	collections,
	onCancel,
	onCreated,
}: Omit<CalendarQuickCreateProps, "onCreated" | "className"> & {
	onCancel: () => void;
	onCreated: (created: Omit<QuickCreated, "trigger">) => void | Promise<void>;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [title, setTitle] = React.useState("");
	const [collection, setCollection] = React.useState(() => lastCollection(collections));
	const [time, setTime] = React.useState(() => defaultTime(day, today, display.timeZone));
	const [error, setError] = React.useState<string>();
	const [pending, setPending] = React.useState(false);
	// A draft that was created but not scheduled; trying again only schedules it.
	const [draft, setDraft] = React.useState<{ collection: string; id: string; locale: string }>();
	const date = display.fullDate(day);
	const zone = display.zoneShortName(dayKeyToUTC(day) + 12 * 3_600_000);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		const target = collections.find((option) => option.slug === collection);
		const [hours = Number.NaN, minutes = Number.NaN] = time.split(":").map(Number);
		if (!target || !title.trim()) return;
		if (Number.isNaN(hours) || Number.isNaN(minutes)) {
			setError(t`Enter a time.`);
			return;
		}
		const at = zonedInstant(day, hours * 60 + minutes, display.timeZone);
		if (at <= Date.now()) {
			setError(t`That time has passed. Pick a later one.`);
			return;
		}
		setPending(true);
		setError(undefined);
		try {
			localStorage.setItem(LAST_COLLECTION_KEY, target.slug);
		} catch {
			// The choice just isn't remembered.
		}
		let created = draft;
		try {
			if (!created) {
				const item = await createContent(target.slug, {
					data: { ...target.defaults, [target.titleField]: title.trim() },
				});
				created = { collection: target.slug, id: item.id, locale: item.locale };
				setDraft(created);
			}
			await scheduleContent(created.collection, created.id, new Date(at).toISOString(), {
				locale: created.locale,
			});
			await onCreated({ collection: created.collection, id: created.id });
		} catch (failure) {
			const message = getMutationError(failure) ?? "";
			setError(created ? t`Saved as a draft, but not scheduled: ${message}` : message);
			setPending(false);
			// The new draft belongs in the Drafts list now.
			if (created) {
				void queryClient.invalidateQueries({ queryKey: ["content", created.collection] });
				void queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
			}
		}
	};

	return (
		<form className="grid gap-3" onSubmit={(event) => void submit(event)}>
			<Popover.Title className="text-sm font-semibold">{date}</Popover.Title>
			<Input
				label={t`Title`}
				value={title}
				onChange={(event) => setTitle(event.target.value)}
				disabled={Boolean(draft)}
				autoFocus
				required
			/>
			{collections.length > 1 && (
				<Select
					className="w-full"
					label={t`Collection`}
					value={collection}
					onValueChange={(value) => setCollection(value ?? collection)}
					disabled={Boolean(draft)}
					items={Object.fromEntries(collections.map((option) => [option.slug, option.label]))}
				/>
			)}
			<Input
				type="time"
				label={t`Time`}
				description={t`In the site's time zone (${zone})`}
				value={time}
				onChange={(event) => setTime(event.target.value)}
				required
			/>
			{error && (
				<p role="alert" className="text-sm text-kumo-danger">
					{error}
				</p>
			)}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="secondary" onClick={onCancel}>
					{t`Cancel`}
				</Button>
				<Button type="submit" variant="primary" loading={pending} disabled={!title.trim()}>
					{t`Schedule`}
				</Button>
			</div>
		</form>
	);
}
