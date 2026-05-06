import { useMutation, useQueryClient } from '@tanstack/react-query';
import { reviewArtifact } from '../api/client';
import { REVIEW_VARIANTS } from '../components/ReviewStatusPill';
import { useToast } from '../components/Toast';
import type { Artifact, ArtifactListResponse, ReviewStatus } from '../types';

type SnapshotEntry = [readonly unknown[], unknown];

// Per-session artifact lists are cached under ['artifacts', <sessionId>]
// where sessionId is a UUID. Other ['artifacts', <string>] keys exist —
// 'list', 'stats', 'coverage-rollup' — and hold differently shaped data
// (objects, not Artifact[]). Match UUIDs explicitly so new sibling keys
// don't accidentally get treated as per-session lists.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSessionArtifactsKey(key: readonly unknown[]): boolean {
  return (
    key.length === 2 &&
    key[0] === 'artifacts' &&
    typeof key[1] === 'string' &&
    UUID_RE.test(key[1])
  );
}

export function useBugReviewMutation() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const mutation = useMutation({
    mutationFn: ({ id, status }: {
      id: string; status: ReviewStatus; prev: ReviewStatus;
    }) => reviewArtifact(id, { review_status: status }),
    onMutate: async ({ id, status }) => {
      // Cancel ONLY the queries we optimistically mutate below. A broad
      // cancel on ['artifacts'] stalls when sibling queries (stats,
      // coverage-rollup) have in-flight fetches that don't honor the
      // abort signal — surfaced as silently-dropped clicks after navigation.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ['artifacts', 'list'] }),
        queryClient.cancelQueries({
          predicate: (q) => isSessionArtifactsKey(q.queryKey),
        }),
      ]);
      const snapshots: SnapshotEntry[] = [];
      const nowIso = new Date().toISOString();

      queryClient
        .getQueriesData<ArtifactListResponse>({ queryKey: ['artifacts', 'list'] })
        .forEach(([key, value]) => {
          if (!value) return;
          snapshots.push([key, value]);
          queryClient.setQueryData<ArtifactListResponse>(key, {
            ...value,
            items: value.items.map((it) =>
              it.id === id
                ? { ...it, review_status: status, reviewed_at: nowIso }
                : it,
            ),
          });
        });

      queryClient
        .getQueriesData<Artifact[]>({
          predicate: (query) => isSessionArtifactsKey(query.queryKey),
        })
        .forEach(([key, value]) => {
          if (!value) return;
          snapshots.push([key, value]);
          queryClient.setQueryData<Artifact[]>(
            key,
            value.map((a) =>
              a.id === id
                ? { ...a, review_status: status, reviewed_at: nowIso }
                : a,
            ),
          );
        });

      return { snapshots };
    },
    onSuccess: (_data, { id, status, prev }) => {
      // Forward transitions get an Undo affordance; undoing back to
      // "unreviewed" doesn't earn its own undo toast.
      if (status === 'unreviewed') return;
      const label = REVIEW_VARIANTS[status].label.toLowerCase();
      toast.push(`Marked as ${label}`, 'success', {
        replaceKey: 'review-undo',
        action: {
          label: 'Undo',
          onClick: () =>
            mutation.mutate({ id, status: prev, prev: status }),
        },
      });
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.snapshots) {
        for (const [key, value] of ctx.snapshots) {
          queryClient.setQueryData(key, value);
        }
      }
      toast.push("Couldn't update review status", 'error', {
        replaceKey: 'review-undo',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['artifacts', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['artifacts', 'stats'] });
      queryClient.invalidateQueries({
        predicate: (query) => isSessionArtifactsKey(query.queryKey),
      });
    },
  });

  function changeReview(id: string, status: ReviewStatus, prev: ReviewStatus) {
    mutation.mutate({ id, status, prev });
  }

  return { changeReview };
}
