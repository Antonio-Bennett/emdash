import { Button, Empty, SkeletonLine } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { DotsSixVertical, FileDashed, X } from "@phosphor-icons/react";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import { fetchContentList } from "../../lib/api/content.js";
import type { CurrentUser } from "../../lib/api/current-user.js";
import { canPublishEntry, formatTimeAgo, type CalendarDisplay } from "../../lib/calendar.js";
import { getEntryTitle } from "../../lib/entryTitle.js";
import { cn } from "../../lib/utils.js";
import { useDraftDrag, type CalendarDraft } from "./CalendarDrag.js";
import { CalendarCollectionTag, useClickAfterDragGuard } from "./CalendarEntry.js";

/** Each collection lists its most recently edited drafts, up to this many. */
const DRAFTS_PER_COLLECTION = 50;

interface DraftCollection {
	slug: string;
	titleField?: string;
}

interface CalendarDraftsProps {
	collections: readonly DraftCollection[];
	display: CalendarDisplay;
	now: number;
	user: CurrentUser | undefined;
	onClose: () => void;
}

interface DraftRow extends CalendarDraft {
	updatedAt: string;
}

/** Drafts with no schedule yet, newest edits first, ready to drag onto a day. */
export function CalendarDrafts({ collections, display, now, user, onClose }: CalendarDraftsProps) {
	const { t } = useLingui();
	const headingId = React.useId();
	const results = useQueries({
		queries: collections.map((collection) => ({
			queryKey: ["content", collection.slug, { status: "draft", calendar: true }],
			queryFn: () =>
				fetchContentList(collection.slug, {
					status: "draft",
					limit: DRAFTS_PER_COLLECTION,
					orderBy: "updatedAt",
					order: "desc",
				}),
		})),
	});
	const loading = results.some((result) => result.isPending);
	const failed = results.some((result) => result.isError);
	const drafts = results
		.flatMap((result, index): DraftRow[] => {
			const collection = collections[index];
			if (!collection || !result.data) return [];
			return result.data.items
				.filter((item) => !item.scheduledAt && canPublishEntry(user, item.authorId))
				.map((item) => ({
					collection: collection.slug,
					id: item.id,
					locale: item.locale,
					title: getEntryTitle(item, collection.titleField),
					updatedAt: item.updatedAt,
				}));
		})
		.toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

	return (
		<section aria-labelledby={headingId} className="flex h-full w-96 flex-col bg-kumo-base">
			<div className="flex shrink-0 items-start justify-between gap-3 ps-5 pe-3 pt-4 pb-3">
				<div className="grid gap-0.5">
					<h2 id={headingId} className="text-base font-semibold">
						{t`Unscheduled drafts`}
					</h2>
					<p className="text-sm text-kumo-subtle">{t`Drag a draft onto a day to schedule it.`}</p>
				</div>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					aria-label={t`Close drafts`}
					icon={<X aria-hidden="true" />}
					onClick={onClose}
				/>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
				{loading ? (
					<div aria-hidden="true" className="grid gap-3 px-2 py-2">
						<SkeletonLine minWidth={50} maxWidth={80} />
						<SkeletonLine minWidth={40} maxWidth={70} />
						<SkeletonLine minWidth={45} maxWidth={75} />
					</div>
				) : drafts.length > 0 ? (
					<ul className="grid gap-1">
						{drafts.map((draft) => (
							<li key={`${draft.collection}:${draft.id}`}>
								<DraftItem draft={draft} display={display} now={now} />
							</li>
						))}
					</ul>
				) : (
					<Empty
						size="sm"
						icon={<FileDashed size={32} aria-hidden="true" />}
						title={failed ? t`Could not load drafts` : t`No unscheduled drafts`}
						description={failed ? undefined : t`New drafts you can publish show up here.`}
					/>
				)}
			</div>
		</section>
	);
}

function DraftItem({
	draft,
	display,
	now,
}: {
	draft: DraftRow;
	display: CalendarDisplay;
	now: number;
}) {
	const { t } = useLingui();
	const { setNodeRef, listeners, isDragging } = useDraftDrag(draft);
	const onClickCapture = useClickAfterDragGuard(isDragging);
	const edited = formatTimeAgo(now - Date.parse(draft.updatedAt), display.locale);

	return (
		<Link
			ref={setNodeRef}
			{...listeners}
			draggable={false}
			to="/content/$collection/$id"
			params={{ collection: draft.collection, id: draft.id }}
			search={{ locale: draft.locale }}
			onClickCapture={onClickCapture}
			className={cn(
				"group grid cursor-grab grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 rounded-md px-2 py-2 text-sm transition-colors hover:bg-kumo-tint focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-kumo-brand motion-reduce:transition-none",
				isDragging && "opacity-40",
			)}
		>
			<DotsSixVertical
				aria-hidden="true"
				className="row-span-2 size-4 text-kumo-inactive group-hover:text-kumo-subtle"
			/>
			<span dir="auto" className="truncate font-medium">
				{draft.title}
			</span>
			<span className="flex min-w-0 items-center gap-2 text-xs text-kumo-subtle">
				<CalendarCollectionTag slug={draft.collection} display={display} size="sm" />
				<span className="truncate">{t`Edited ${edited}`}</span>
			</span>
		</Link>
	);
}
