/**
 * Tests for offline-queue.ts — enqueue, dequeue, deduplication, ordering, persistence.
 */
import { OfflineQueue } from "../src/offline-queue";
import { QueueEntry } from "../src/types";

function makeEntry(path: string, timestamp?: number): QueueEntry {
    return {
        path,
        content: `content of ${path}`,
        mtime: timestamp || Date.now(),
        timestamp: timestamp || Date.now(),
        action: "push" as any,
    };
}

// ---------------------------------------------------------------------------
// Basic operations
// ---------------------------------------------------------------------------

describe("OfflineQueue basics", () => {
    test("starts empty", () => {
        const q = new OfflineQueue();
        expect(q.size).toBe(0);
        expect(q.all()).toEqual([]);
    });

    test("enqueue increases size", async () => {
        const q = new OfflineQueue();
        await q.enqueue(makeEntry("a.md"));
        expect(q.size).toBe(1);
    });

    test("dequeue removes entry", async () => {
        const q = new OfflineQueue();
        await q.enqueue(makeEntry("a.md"));
        await q.dequeue("a.md");
        expect(q.size).toBe(0);
    });

    test("dequeue non-existent path is safe", async () => {
        const q = new OfflineQueue();
        await q.dequeue("nonexistent.md");
        expect(q.size).toBe(0);
    });

    test("clear removes all entries", async () => {
        const q = new OfflineQueue();
        await q.enqueue(makeEntry("a.md"));
        await q.enqueue(makeEntry("b.md"));
        await q.clear();
        expect(q.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("OfflineQueue deduplication", () => {
    test("newer entry for same path replaces older", async () => {
        const q = new OfflineQueue();
        await q.enqueue(makeEntry("a.md", 1000));
        await q.enqueue(makeEntry("a.md", 2000));
        expect(q.size).toBe(1);
        expect(q.all()[0].timestamp).toBe(2000);
    });

    test("different paths are kept separate", async () => {
        const q = new OfflineQueue();
        await q.enqueue(makeEntry("a.md", 1000));
        await q.enqueue(makeEntry("b.md", 2000));
        expect(q.size).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe("OfflineQueue ordering", () => {
    test("all() returns entries sorted oldest first", async () => {
        const q = new OfflineQueue();
        await q.enqueue(makeEntry("c.md", 3000));
        await q.enqueue(makeEntry("a.md", 1000));
        await q.enqueue(makeEntry("b.md", 2000));
        const paths = q.all().map((e) => e.path);
        expect(paths).toEqual(["a.md", "b.md", "c.md"]);
    });
});

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

describe("OfflineQueue load", () => {
    test("load replaces all entries", () => {
        const q = new OfflineQueue();
        q.load([makeEntry("a.md", 1000), makeEntry("b.md", 2000)]);
        expect(q.size).toBe(2);
    });

    test("load clears previous entries", async () => {
        const q = new OfflineQueue();
        await q.enqueue(makeEntry("old.md"));
        q.load([makeEntry("new.md")]);
        expect(q.size).toBe(1);
        expect(q.all()[0].path).toBe("new.md");
    });

    test("load deduplicates by path", () => {
        const q = new OfflineQueue();
        q.load([makeEntry("a.md", 1000), makeEntry("a.md", 2000)]);
        expect(q.size).toBe(1);
        expect(q.all()[0].timestamp).toBe(2000);
    });
});

// ---------------------------------------------------------------------------
// Persistence callbacks
// ---------------------------------------------------------------------------

describe("OfflineQueue persistence", () => {
    test("dequeue triggers immediate persist", async () => {
        const persistFn = jest.fn().mockResolvedValue(undefined);
        const q = new OfflineQueue();
        q.onPersist(persistFn);
        await q.enqueue(makeEntry("a.md"));
        await q.dequeue("a.md");
        expect(persistFn).toHaveBeenCalledWith([]);
    });

    test("clear triggers immediate persist", async () => {
        const persistFn = jest.fn().mockResolvedValue(undefined);
        const q = new OfflineQueue();
        q.onPersist(persistFn);
        await q.enqueue(makeEntry("a.md"));
        await q.clear();
        expect(persistFn).toHaveBeenCalledWith([]);
    });

    test("enqueue debounces persist", async () => {
        jest.useFakeTimers();
        const persistFn = jest.fn().mockResolvedValue(undefined);
        const q = new OfflineQueue(500);
        q.onPersist(persistFn);

        await q.enqueue(makeEntry("a.md"));
        expect(persistFn).not.toHaveBeenCalled();

        jest.advanceTimersByTime(500);
        // Allow microtask to resolve
        await Promise.resolve();
        expect(persistFn).toHaveBeenCalledTimes(1);

        jest.useRealTimers();
    });

    test("rapid enqueues coalesce into one persist", async () => {
        jest.useFakeTimers();
        const persistFn = jest.fn().mockResolvedValue(undefined);
        const q = new OfflineQueue(500);
        q.onPersist(persistFn);

        await q.enqueue(makeEntry("a.md"));
        await q.enqueue(makeEntry("b.md"));
        await q.enqueue(makeEntry("c.md"));

        jest.advanceTimersByTime(500);
        await Promise.resolve();
        expect(persistFn).toHaveBeenCalledTimes(1);
        expect(persistFn).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({ path: "a.md" }),
            expect.objectContaining({ path: "b.md" }),
            expect.objectContaining({ path: "c.md" }),
        ]));

        jest.useRealTimers();
    });

    test("no persist callback is safe", async () => {
        const q = new OfflineQueue();
        // Should not throw
        await q.enqueue(makeEntry("a.md"));
        await q.dequeue("a.md");
        await q.clear();
    });
});

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

describe("OfflineQueue destroy", () => {
    test("destroy cancels pending persist timer", async () => {
        jest.useFakeTimers();
        const persistFn = jest.fn().mockResolvedValue(undefined);
        const q = new OfflineQueue(500);
        q.onPersist(persistFn);

        await q.enqueue(makeEntry("a.md"));
        q.destroy();

        jest.advanceTimersByTime(1000);
        await Promise.resolve();
        expect(persistFn).not.toHaveBeenCalled();

        jest.useRealTimers();
    });
});
