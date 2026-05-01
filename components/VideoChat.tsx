"use client";

import { useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  createLocalAudioTrack,
  createLocalVideoTrack,
} from "livekit-client";
import { API_BASE_URL } from "@/lib/api";

type AuthUser = {
  id: string;
  email: string;
  displayName: string;
};

type ChatRoom = {
  id: string;
  host_user_id: string;
  host_display_name: string;
  room_name: string;
  status: "active" | "ended";
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  active_participants_count?: number;
};

type RoomAccessResponse = {
  room: ChatRoom;
  participantIdentity: string;
  livekit: {
    token: string;
    wsUrl: string;
  };
};

export function VideoChat() {
  const [email, setEmail] = useState("user1@test.com");
  const [password, setPassword] = useState("password1");

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  const [guestName, setGuestName] = useState("Guest");

  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [currentRoom, setCurrentRoom] = useState<ChatRoom | null>(null);
  const [participantIdentity, setParticipantIdentity] = useState<string | null>(
    null,
  );

  const [status, setStatus] = useState("idle");
  const [isBusy, setIsBusy] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  const livekitRoomRef = useRef<Room | null>(null);

  const isHost =
    !!user && !!currentRoom && currentRoom.host_user_id === user.id;

  async function fetchActiveRooms() {
    const response = await fetch(`${API_BASE_URL}/api/v1/rooms/active`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error || "Failed to fetch rooms");
    }

    setRooms(data.rooms);
  }

  useEffect(() => {
  let isCancelled = false;

  async function loadActiveRooms() {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/rooms/active`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Failed to fetch rooms");
      }

      if (!isCancelled) {
        setRooms(data.rooms);
      }
    } catch {
      // ignore polling errors for MVP
    }
  }

  void loadActiveRooms();

  const intervalId = window.setInterval(() => {
    void loadActiveRooms();
  }, 3000);

  return () => {
    isCancelled = true;
    window.clearInterval(intervalId);
  };
}, []);

  async function login() {
    try {
      setIsBusy(true);
      setStatus("logging in");

      const response = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Failed to login");
      }

      setAccessToken(data.accessToken);
      setUser(data.user);
      setStatus(`logged in as ${data.user.displayName}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "login error");
    } finally {
      setIsBusy(false);
    }
  }

  async function cleanupLiveKit() {
    livekitRoomRef.current?.disconnect();
    livekitRoomRef.current = null;

    setIsConnected(false);

    document.getElementById("local-media")?.replaceChildren();
    document.getElementById("remote-media")?.replaceChildren();
  }

  async function connectToLiveKit(result: RoomAccessResponse) {
    await cleanupLiveKit();

    const livekitRoom = new Room();

    livekitRoom.on(RoomEvent.Connected, () => {
      setIsConnected(true);
      setStatus("connected");
    });

    livekitRoom.on(RoomEvent.Disconnected, () => {
      setIsConnected(false);
      setStatus("disconnected");
    });

    livekitRoom.on(RoomEvent.TrackSubscribed, (track) => {
      const element = track.attach();

      if (element instanceof HTMLVideoElement) {
        element.autoplay = true;
        element.playsInline = true;
        element.className = "w-full max-h-[240px] rounded-md bg-black";
      }

      if (element instanceof HTMLAudioElement) {
        element.autoplay = true;
      }

      document.getElementById("remote-media")?.appendChild(element);
    });

    livekitRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((element) => element.remove());
    });

    await livekitRoom.connect(result.livekit.wsUrl, result.livekit.token);

    const audioTrack = await createLocalAudioTrack();
    const videoTrack = await createLocalVideoTrack();

    await livekitRoom.localParticipant.publishTrack(audioTrack);
    await livekitRoom.localParticipant.publishTrack(videoTrack);

    const localVideoElement = videoTrack.attach();

    if (localVideoElement instanceof HTMLVideoElement) {
      localVideoElement.muted = true;
      localVideoElement.autoplay = true;
      localVideoElement.playsInline = true;
      localVideoElement.className = "w-full max-h-[240px] rounded-md bg-black";
    }

    document.getElementById("local-media")?.replaceChildren(localVideoElement);

    livekitRoomRef.current = livekitRoom;
    setCurrentRoom(result.room);
    setParticipantIdentity(result.participantIdentity);
  }

  async function createRoom() {
    if (!accessToken) {
      setStatus("login required");
      return;
    }

    try {
      setIsBusy(true);
      setStatus("creating room");

      const response = await fetch(`${API_BASE_URL}/api/v1/rooms`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Failed to create room");
      }

      await connectToLiveKit(data);
      await fetchActiveRooms();

      setStatus("room created");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "create room error");
    } finally {
      setIsBusy(false);
    }
  }

  async function joinRoom(roomId: string) {
    if (isConnected) {
      setStatus("leave current room first");
      return;
    }

    try {
      setIsBusy(true);
      setStatus("joining room");

      const response = await fetch(
        `${API_BASE_URL}/api/v1/rooms/${roomId}/join`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify({
            displayName: user?.displayName ?? guestName,
          }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Failed to join room");
      }

      await connectToLiveKit(data);
      await fetchActiveRooms();

      setStatus("joined room");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "join room error");
    } finally {
      setIsBusy(false);
    }
  }

  async function leaveRoom() {
    if (!currentRoom) {
      await cleanupLiveKit();
      return;
    }

    try {
      setIsBusy(true);

      await fetch(`${API_BASE_URL}/api/v1/rooms/${currentRoom.id}/leave`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          participantIdentity,
        }),
      });

      await cleanupLiveKit();

      setCurrentRoom(null);
      setParticipantIdentity(null);

      await fetchActiveRooms();

      setStatus("left room");
    } finally {
      setIsBusy(false);
    }
  }

  async function endRoom() {
    if (!currentRoom || !accessToken) return;

    try {
      setIsBusy(true);

      const response = await fetch(
        `${API_BASE_URL}/api/v1/rooms/${currentRoom.id}/end`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Failed to end room");
      }

      await cleanupLiveKit();

      setCurrentRoom(null);
      setParticipantIdentity(null);

      await fetchActiveRooms();

      setStatus("room ended");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "end room error");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Video Chat MVP</h1>

      <section className="rounded-lg border p-4">
        <h2 className="mb-4 text-lg font-medium">Auth</h2>

        <div className="grid gap-3 md:grid-cols-3">
          <input
            className="rounded border px-3 py-2"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Email"
          />

          <input
            className="rounded border px-3 py-2"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
          />

          <button
            className="rounded border px-4 py-2 disabled:opacity-50"
            onClick={login}
            disabled={isBusy}
          >
            Login
          </button>
        </div>

        {!user && (
          <input
            className="rounded border px-3 py-2"
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            placeholder="Your name"
          />
        )}
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="mb-4 text-lg font-medium">Controls</h2>

        <div className="flex flex-wrap gap-3">
          <button
            className="rounded border px-4 py-2 disabled:opacity-50"
            onClick={createRoom}
            disabled={isBusy || !accessToken || isConnected}
          >
            Start video chat
          </button>

          <button
            className="rounded border px-4 py-2 disabled:opacity-50"
            onClick={leaveRoom}
            disabled={isBusy || !currentRoom}
          >
            Leave
          </button>

          {isHost && (
            <button
              className="rounded border px-4 py-2 disabled:opacity-50"
              onClick={endRoom}
              disabled={isBusy}
            >
              End my video chat
            </button>
          )}
        </div>

        <p className="mt-3 text-sm">
          <b>Status:</b> {status}
        </p>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="mb-4 text-lg font-medium">Active video chats</h2>

        {rooms.length === 0 ? (
          <p className="text-sm text-gray-500">No active video chats</p>
        ) : (
          <div className="flex flex-col gap-3">
            {rooms.map((room) => (
              <div
                key={room.id}
                className="flex items-center justify-between rounded border p-3"
              >
                <div>
                  <p className="font-medium">
                    {room.host_display_name} is in video chat now
                  </p>
                  <p className="text-sm text-gray-500">
                    Participants: {room.active_participants_count ?? 0}/5
                  </p>
                </div>

                <button
                  className="rounded border px-4 py-2 disabled:opacity-50"
                  onClick={() => joinRoom(room.id)}
                  disabled={isBusy || isConnected}
                >
                  Join
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="mb-2 text-lg font-medium">Local media</h2>
          <div
            id="local-media"
            className="flex min-h-[240px] items-center justify-center rounded-lg border"
          />
        </div>

        <div>
          <h2 className="mb-2 text-lg font-medium">Remote media</h2>
          <div
            id="remote-media"
            className="flex min-h-[240px] flex-col gap-3 rounded-lg border p-3"
          />
        </div>
      </section>
    </main>
  );
}
