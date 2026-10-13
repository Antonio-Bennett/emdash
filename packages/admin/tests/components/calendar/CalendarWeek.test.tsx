import { describe, expect, it, vi } from "vitest";

import "../../../dist/styles.css";
import type { CalendarEntry } from "../../../src/lib/api/calendar";
import {
	createCalendarDisplay,
	groupByDay,
	toCalendarItems,
	weekDays,
} from "../../../src/lib/calendar";
import { render } from "../../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => ({
	...(await vi.importActual("@tanstack/react-router")),
	Link: ({ to: _to, params: _params, search: _search, children, ...props }: any) => (
		<a href="#entry" {...props}>
			{children}
		</a>
	),
}));

const { CalendarWeek } = await import("../../../src/components/calendar/CalendarWeek");

const timeZone = "Asia/Tokyo";
const display = createCalendarDisplay({
	locale: "en",
	timeZone,
	viewerTimeZone: timeZone,
	collections: [{ slug: "posts", label: "Posts" }],
	showLocale: false,
});

function entry(id: string, at: string): CalendarEntry {
	return {
		collection: "posts",
		id,
		locale: "en",
		title: `Entry ${id}`,
		status: "draft",
		kind: "scheduled",
		at,
	};
}

function renderWeek(entries: CalendarEntry[], onSelect = vi.fn()) {
	const items = groupByDay(
		toCalendarItems(entries, {
			timeZone,
			loadedAt: Date.parse("2026-10-01T00:00:00.000Z"),
			collectionOrder: ["posts"],
		}),
	);
	return render(
		<div style={{ display: "flex", flexDirection: "column", width: 1100, height: 700 }}>
			<CalendarWeek
				days={weekDays("2026-10-14", 0)}
				items={items}
				today="2026-10-01"
				now={Date.parse("2026-10-01T00:00:00.000Z")}
				display={display}
				onSelect={onSelect}
			/>
		</div>,
	);
}

describe("CalendarWeek", () => {
	it("places an entry on its site-zone day at its hour", async () => {
		// 20:00 UTC on the 13th is 5:00 on the 14th in Tokyo.
		const screen = await renderWeek([entry("late", "2026-10-13T20:00:00.000Z")]);

		const day = screen.getByRole("list", { name: "Wednesday, October 14, 2026" });
		const link = day.getByRole("link", { name: /Entry late/ });
		await expect.element(link).toBeVisible();

		const column = day.element().parentElement!.getBoundingClientRect();
		const top = link.element().getBoundingClientRect().top - column.top;
		// Hours are 48px tall.
		expect(top / 48).toBe(5);
	});

	it("folds entries at the same time into one row with the rest behind +N more", async () => {
		const onSelect = vi.fn();
		const screen = await renderWeek(
			[
				entry("a", "2026-10-14T00:00:00.000Z"),
				entry("b", "2026-10-14T00:00:00.000Z"),
				entry("c", "2026-10-14T00:10:00.000Z"),
				entry("later", "2026-10-14T03:00:00.000Z"),
			],
			onSelect,
		);
		const day = screen.getByRole("list", { name: "Wednesday, October 14, 2026" });

		expect(
			day
				.getByRole("link")
				.elements()
				.map((link) => link.textContent),
		).toEqual([expect.stringContaining("Entry a"), expect.stringContaining("Entry later")]);
		await day
			.getByRole("button", { name: "2 more entries on Wednesday, October 14, 2026" })
			.click();
		await screen
			.getByRole("dialog")
			.getByRole("link", { name: /Entry c/ })
			.click();

		expect(onSelect).toHaveBeenLastCalledWith(
			expect.objectContaining({ key: "posts:c:scheduled" }),
			expect.any(HTMLElement),
		);
	});
});
