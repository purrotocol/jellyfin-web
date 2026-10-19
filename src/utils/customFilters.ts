import type { Api } from '@jellyfin/sdk';
import type { GenericAbortSignal } from 'axios';

import { CustomFilter, type LibraryViewSettings, type ParentId } from 'types/library';
import { LibraryTab } from 'types/libraryTab';

// Kestrel's default request-line limit is 8KB; ~240 32-char ids already fits only barely, so cap
// below that and leave headroom for the rest of the query.
const MAX_FILTER_IDS = 200;
const RETRIES = 2;
const RETRY_DELAY_MS = 2000;

// The dislike index only covers video item kinds.
const SUPPORTED_TABS = [ LibraryTab.Movies, LibraryTab.Episodes, LibraryTab.Videos, LibraryTab.MusicVideos ];

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Membership is [min, max); bounds are sent as minSize/maxSize to /Items.
export const SIZE_BUCKETS = [
    { value: 'lt250mb', label: 'Under 250 MB', min: undefined, max: 250 * MB },
    { value: 'mb250to500', label: '250 MB – 500 MB', min: 250 * MB, max: 500 * MB },
    { value: 'mb500to1gb', label: '500 MB – 1 GB', min: 500 * MB, max: GB },
    { value: 'gb1to2', label: '1 GB – 2 GB', min: GB, max: 2 * GB },
    { value: 'gt2gb', label: 'Over 2 GB', min: 2 * GB, max: undefined }
];

export const supportsCustomFilters = (viewType: LibraryTab) => SUPPORTED_TABS.includes(viewType);

export const getSizeQuery = (viewType: LibraryTab, libraryViewSettings: LibraryViewSettings) => {
    const bucket = SIZE_BUCKETS.find(b => b.value === libraryViewSettings.Filters?.Size);
    if (!bucket || !supportsCustomFilters(viewType)) return {};
    return { minSize: bucket.min, maxSize: bucket.max };
};

interface DislikeListResponse { Items?: { ItemId?: string }[] }
interface RatedItemsResponse { ItemIds?: string[] }

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The endpoints answer 503 while a user's index is still rebuilding (and kick the rebuild).
async function getWithRetry<T>(api: Api, path: string, parentId: ParentId, signal?: GenericAbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            const response = await api.axiosInstance.get<T>(
                api.getUri(path, { parentId: parentId ?? undefined }),
                { signal, headers: { Authorization: api.authorizationHeader } }
            );
            return response.data;
        } catch (err) {
            if (attempt >= RETRIES || signal?.aborted) throw err;
            await delay(RETRY_DELAY_MS);
        }
    }
}

export type CustomFilterQuery =
    | { kind: 'none' }
    | { kind: 'empty' }
    | { kind: 'ids', ids: string[] }
    | { kind: 'excludeIds', ids: string[] };

export async function getCustomFilterQuery(
    api: Api,
    viewType: LibraryTab,
    parentId: ParentId,
    libraryViewSettings: LibraryViewSettings,
    signal?: GenericAbortSignal
): Promise<CustomFilterQuery> {
    const mode = libraryViewSettings.Filters?.Custom?.[0];
    if (!mode || !supportsCustomFilters(viewType)) return { kind: 'none' };

    let ids: string[];
    if (mode === CustomFilter.Disliked) {
        const data = await getWithRetry<DislikeListResponse>(api, '/Plugins/TrickplayStatus/Dislikes', parentId, signal);
        ids = (data.Items ?? []).map(i => i.ItemId).filter((id): id is string => !!id);
        // An empty `ids` means "no id filter" to the server, not "no items".
        if (!ids.length) return { kind: 'empty' };
    } else {
        const data = await getWithRetry<RatedItemsResponse>(api, '/Plugins/TrickplayStatus/Dislikes/Rated', parentId, signal);
        ids = data.ItemIds ?? [];
        if (!ids.length) return { kind: 'none' };
    }

    if (ids.length > MAX_FILTER_IDS) {
        console.warn(`[customFilters] ${ids.length} ids exceeds the ${MAX_FILTER_IDS} query limit; ${mode} filter not applied`);
        return { kind: 'none' };
    }

    return mode === CustomFilter.Disliked ? { kind: 'ids', ids } : { kind: 'excludeIds', ids };
}
