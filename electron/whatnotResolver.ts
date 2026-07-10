import type { FollowingFeedLiveStream, StreamCard } from "./types.js";

const normalizeName = (value: string): string => value.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]/g, "");

export class WhatnotResolver {
  async resolve(card: StreamCard, liveStreams: FollowingFeedLiveStream[] = []): Promise<StreamCard> {
    const streamer = card.streamer.trim().replace(/^@/, "");
    if (!streamer) {
      return { ...card, status: "empty", resolvedUrl: null, streamUuid: null, error: null };
    }

    const normalizedStreamer = normalizeName(streamer);
    const matchingStreams = liveStreams.filter((stream) => {
      if (stream.normalizedUsername) return stream.normalizedUsername === normalizedStreamer;
      if (stream.username) return normalizeName(stream.username) === normalizedStreamer;
      return false;
    });
    const liveMatch = matchingStreams.find((stream) => stream.lifecycleState === "online" && stream.isLive);

    if (!liveMatch) {
      return {
        ...card,
        streamer,
        status: "offline",
        resolvedUrl: null,
        streamUuid: null,
        title: streamer,
        currentItem: null,
        giveawayName: null,
        entryCount: null,
        thumbnailImageDataUrl: card.thumbnailImageDataUrl,
        streamPreviewImageDataUrl: null,
        lastResolvedAt: new Date().toISOString(),
        error: null
      };
    }

    return {
      ...card,
      streamer,
      status: "live",
      resolvedUrl: liveMatch.streamUrl || null,
      streamUuid: liveMatch.streamId,
      title: streamer,
      currentItem: liveMatch.matchText,
      giveawayName: null,
      entryCount: null,
      thumbnailImageDataUrl: liveMatch.thumbnailImageDataUrl,
      streamPreviewImageDataUrl: card.streamPreviewImageDataUrl,
      lastResolvedAt: new Date().toISOString(),
      error: null
    };
  }
}
