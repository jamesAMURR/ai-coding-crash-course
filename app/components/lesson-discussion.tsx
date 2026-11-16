import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { MessageSquare, Reply, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { UserAvatar } from "~/components/user-avatar";
import { MAX_COMMENT_LENGTH, splitCommentText } from "~/lib/comments";
import { cn } from "~/lib/utils";
import type {
  CommentBadge,
  LessonCommentThread,
  LessonCommentView,
} from "~/services/lessonCommentService";

type ActionResult = { ok: boolean; error: string | null };

export function LessonDiscussion({
  comments,
  commentCount,
  canPost,
  isArchived,
}: {
  comments: LessonCommentThread[];
  commentCount: number;
  canPost: boolean;
  isArchived: boolean;
}) {
  return (
    <section className="mb-8 border-t pt-6">
      <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold">
        <MessageSquare className="size-5" />
        Discussion
        <span className="text-base font-normal text-muted-foreground">
          ({commentCount})
        </span>
      </h2>

      {canPost && (
        <CommentForm
          parentId={null}
          placeholder="Ask a question or share a thought..."
          submitLabel="Post comment"
        />
      )}

      {isArchived && (
        <p className="mb-4 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          Discussion is closed for archived courses.
        </p>
      )}

      {comments.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No comments yet. Start the discussion.
        </p>
      ) : (
        <ul className="mt-6 space-y-6">
          {comments.map((thread) => (
            <CommentThread key={thread.id} thread={thread} canPost={canPost} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CommentThread({
  thread,
  canPost,
}: {
  thread: LessonCommentThread;
  canPost: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const canReply = canPost && !thread.deleted;

  return (
    <li>
      <Comment
        comment={thread}
        onReply={canReply ? () => setReplying((open) => !open) : undefined}
      />

      {(thread.replies.length > 0 || replying) && (
        <div className="ml-11 mt-4 space-y-4 border-l pl-4">
          {thread.replies.length > 0 && (
            <ul className="space-y-4">
              {thread.replies.map((reply) => (
                <li key={reply.id}>
                  <Comment comment={reply} />
                </li>
              ))}
            </ul>
          )}
          {replying && (
            <CommentForm
              parentId={thread.id}
              placeholder="Write a reply..."
              submitLabel="Reply"
              autoFocus
              onPosted={() => setReplying(false)}
              onCancel={() => setReplying(false)}
            />
          )}
        </div>
      )}
    </li>
  );
}

function Comment({
  comment,
  onReply,
}: {
  comment: LessonCommentView;
  onReply?: () => void;
}) {
  const name = comment.author?.name ?? "[deleted user]";

  return (
    <div className="flex gap-3">
      <UserAvatar
        name={comment.author?.name ?? "?"}
        avatarUrl={comment.author?.avatarUrl ?? null}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span
            className={cn(
              "font-medium",
              !comment.author && "italic text-muted-foreground"
            )}
          >
            {name}
          </span>
          <RoleBadge badge={comment.author?.badge ?? null} />
          <RelativeTime iso={comment.createdAt} />
        </div>

        {comment.deleted ? (
          <p className="mt-1 text-sm italic text-muted-foreground">
            {comment.removedByModerator ? "[removed by instructor]" : "[deleted]"}
          </p>
        ) : (
          <CommentBody text={comment.body} />
        )}

        {(onReply || comment.canDelete) && (
          <div className="mt-1 flex items-center gap-1">
            {onReply && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-muted-foreground"
                onClick={onReply}
              >
                <Reply className="mr-1 size-3.5" />
                Reply
              </Button>
            )}
            {comment.canDelete && <DeleteCommentButton commentId={comment.id} />}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Renders comment text as React text nodes — never as HTML — with http(s)
 * URLs turned into links. Line breaks are preserved via whitespace-pre-wrap.
 */
function CommentBody({ text }: { text: string }) {
  return (
    <p className="mt-1 whitespace-pre-wrap break-words text-sm">
      {splitCommentText(text).map((segment, i) =>
        segment.type === "link" ? (
          <a
            key={i}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-primary underline underline-offset-2"
          >
            {segment.value}
          </a>
        ) : (
          segment.value
        )
      )}
    </p>
  );
}

function RoleBadge({ badge }: { badge: CommentBadge }) {
  if (!badge) return null;
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-xs font-medium",
        badge === "instructor"
          ? "bg-primary/10 text-primary"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
      )}
    >
      {badge === "instructor" ? "Instructor" : "Admin"}
    </span>
  );
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60],
  ["month", 30 * 24 * 60 * 60],
  ["week", 7 * 24 * 60 * 60],
  ["day", 24 * 60 * 60],
  ["hour", 60 * 60],
  ["minute", 60],
];

function formatRelative(iso: string) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) {
      return format.format(Math.round(seconds / size), unit);
    }
  }
  return "just now";
}

function RelativeTime({ iso }: { iso: string }) {
  return (
    <time
      dateTime={iso}
      title={new Date(iso).toLocaleString()}
      className="text-xs text-muted-foreground"
      suppressHydrationWarning
    >
      {formatRelative(iso)}
    </time>
  );
}

function CommentForm({
  parentId,
  placeholder,
  submitLabel,
  autoFocus,
  onPosted,
  onCancel,
}: {
  parentId: number | null;
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  onPosted?: () => void;
  onCancel?: () => void;
}) {
  const fetcher = useFetcher<ActionResult>();
  const formRef = useRef<HTMLFormElement>(null);
  const [length, setLength] = useState(0);
  const isPosting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      formRef.current?.reset();
      setLength(0);
      onPosted?.();
    } else if (fetcher.data.error) {
      toast.error(fetcher.data.error);
    }
    // Only react to a request finishing, not to callback identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  return (
    <fetcher.Form method="post" ref={formRef} className="space-y-2">
      <input type="hidden" name="intent" value="add-comment" />
      {parentId !== null && (
        <input type="hidden" name="parentId" value={parentId} />
      )}
      <Textarea
        name="body"
        required
        maxLength={MAX_COMMENT_LENGTH}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={isPosting}
        onChange={(e) => setLength(e.target.value.length)}
      />
      <div className="flex items-center justify-end gap-2">
        {length > MAX_COMMENT_LENGTH * 0.9 && (
          <span className="mr-auto text-xs text-muted-foreground">
            {length}/{MAX_COMMENT_LENGTH}
          </span>
        )}
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" disabled={isPosting || length === 0}>
          {isPosting ? "Posting..." : submitLabel}
        </Button>
      </div>
    </fetcher.Form>
  );
}

function DeleteCommentButton({ commentId }: { commentId: number }) {
  const fetcher = useFetcher<ActionResult>();
  const isDeleting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.error) {
      toast.error(fetcher.data.error);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <fetcher.Form
      method="post"
      onSubmit={(e) => {
        if (!window.confirm("Delete this comment? This can't be undone.")) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="intent" value="delete-comment" />
      <input type="hidden" name="commentId" value={commentId} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-muted-foreground hover:text-destructive"
        disabled={isDeleting}
      >
        <Trash2 className="mr-1 size-3.5" />
        {isDeleting ? "Deleting..." : "Delete"}
      </Button>
    </fetcher.Form>
  );
}
