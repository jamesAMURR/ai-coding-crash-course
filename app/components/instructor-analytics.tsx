import type { ReactNode } from "react";
import { Link } from "react-router";
import { Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { CourseStatus } from "~/db/schema";
import type {
  InstructorAnalytics,
  InstructorAnalyticsSummary,
  InstructorCourseRow,
} from "~/services/instructorAnalyticsService";

// ─── Instructor Analytics Section ───
// Read-only analytics shown above the enrolled courses on /dashboard for
// instructors. Tiles and table columns are declared as lists below: adding a
// metric means appending one entry to TILES and/or COLUMNS. A `null` metric
// renders as "—" via formatMetric.

export function formatMetric<T>(
  value: T | null | undefined,
  format: (value: T) => ReactNode = (v) => String(v)
): ReactNode {
  return value === null || value === undefined ? "—" : format(value);
}

type Tile = {
  label: string;
  value: (summary: InstructorAnalyticsSummary) => ReactNode;
  detail?: (summary: InstructorAnalyticsSummary) => ReactNode;
};

const TILES: Tile[] = [
  {
    label: "Courses teaching",
    value: (s) => formatMetric(s.coursesTeaching),
  },
  {
    label: "Total students",
    value: (s) => formatMetric(s.totalStudents),
    detail: (s) => `${s.newStudentsLast30Days} new in the last 30 days`,
  },
];

type Column = {
  header: string;
  align?: "left" | "right";
  cell: (row: InstructorCourseRow) => ReactNode;
};

const COLUMNS: Column[] = [
  {
    header: "Course",
    cell: (row) => (
      <Link to={`/courses/${row.slug}`} className="font-medium hover:text-primary">
        {row.title}
      </Link>
    ),
  },
  {
    header: "Status",
    cell: (row) => <StatusBadge status={row.status} />,
  },
  {
    header: "Students",
    align: "right",
    cell: (row) => formatMetric(row.students),
  },
  {
    header: "% completed",
    align: "right",
    cell: (row) => formatMetric(row.completionRate, formatPercent),
  },
  {
    header: "Avg. progress",
    align: "right",
    cell: (row) => formatMetric(row.averageProgress, formatPercent),
  },
];

function formatPercent(ratio: number) {
  return `${Math.round(ratio * 100)}%`;
}

function StatusBadge({ status }: { status: CourseStatus }) {
  if (status === CourseStatus.Archived) {
    return (
      <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800 dark:bg-gray-900/30 dark:text-gray-400">
        Archived
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
      Teaching
    </span>
  );
}

function alignClass(align: Column["align"]) {
  return align === "right" ? "text-right" : "text-left";
}

export function InstructorAnalyticsSection({
  analytics,
}: {
  analytics: InstructorAnalytics;
}) {
  const { summary, courses } = analytics;

  return (
    <section className="mb-10">
      <h2 className="mb-4 text-xl font-semibold">Instructor analytics</h2>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {TILES.map((tile) => (
          <Card key={tile.label} className="gap-2">
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {tile.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{tile.value(summary)}</div>
              {tile.detail && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {tile.detail(summary)}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              {COLUMNS.map((column) => (
                <th
                  key={column.header}
                  className={`px-4 py-2 font-medium ${alignClass(column.align)}`}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {courses.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  <p>You have no published or archived courses yet.</p>
                  <Link to="/instructor/new" className="mt-3 inline-block">
                    <Button size="sm">
                      <Plus className="mr-1 size-4" />
                      New course
                    </Button>
                  </Link>
                </td>
              </tr>
            ) : (
              courses.map((row) => (
                <tr key={row.id} className="border-t">
                  {COLUMNS.map((column) => (
                    <td
                      key={column.header}
                      className={`px-4 py-2 ${alignClass(column.align)}`}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
