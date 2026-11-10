import { Bone, skeletonPulse } from "@/components/ui/Skeleton";

const GOALS = [
  { title: "w-2/5", tasks: ["w-1/2", "w-2/5", "w-3/5"] },
  { title: "w-1/2", tasks: ["w-2/5", "w-1/3"] },
  { title: "w-1/3", tasks: ["w-3/5", "w-1/2"] },
  { title: "w-2/5", tasks: ["w-1/3"] },
];

/**
 * Graph placeholder: the Advanced switch, then goal cards (title, badges,
 * score, linked task rows) in the same one/two-column grid as the real view.
 */
export function GraphSkeleton() {
  return (
    <div
      data-component="GraphSkeleton"
      aria-hidden="true"
      className={`flex flex-col gap-3 pb-24 lg:pb-8 ${skeletonPulse}`}
    >
      <div className="flex justify-end">
        <Bone className="h-8 w-28" />
      </div>
      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
        {GOALS.map((goal, i) => (
          <div
            key={i}
            data-skeleton-row
            className="min-w-0 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <Bone className={`h-4 ${goal.title}`} />
                <Bone className="h-5 w-12 rounded-full" />
                <Bone className="h-5 w-14 rounded-full" />
              </div>
              <Bone className="h-5 w-9 shrink-0 rounded-full" />
            </div>
            <div className="mt-3 flex flex-col gap-3 border-l border-[var(--color-border)] pl-3">
              {goal.tasks.map((w, j) => (
                <div key={j} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Bone className={`h-3 ${w}`} />
                    <Bone className="h-4 w-10 rounded-full" />
                  </div>
                  <Bone className="h-2.5 w-1/4" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <Bone className="h-2.5 w-1/2" />
    </div>
  );
}
