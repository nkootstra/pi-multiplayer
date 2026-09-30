// Direct transport: the host listens on a TCP port and guests connect to it (LAN, VPN, tailnet).
import { connect, createServer } from "node:net";
import type { MultiplayerHost } from "./host.ts";
import { type ClientMessage, encodeFrame, FrameDecoder, type ServerMessage } from "./protocol.ts";
import type { GuestLink, LinkHandlers } from "./guest.ts";

/** Starts accepting direct guest connections. Resolves with the bound port (useful when `port` is 0). */
export async function listenTcp(host: MultiplayerHost, port: number, bind: string): Promise<number> {
	const server = createServer((socket) => {
		socket.setEncoding("utf8");
		socket.setNoDelay(true);
		const decoder = new FrameDecoder();
		const peer = host.connect({
			send: (message) => {
				if (!socket.destroyed) socket.write(encodeFrame(message));
			},
			end: (final) => {
				if (socket.destroyed) return;
				if (final) socket.end(encodeFrame(final));
				else socket.end();
			},
		});
		socket.on("data", (chunk: string) => {
			try {
				for (const frame of decoder.push(chunk)) peer.receive(frame);
			} catch {
				socket.destroy();
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => peer.closed());
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, bind, () => {
			server.off("error", reject);
			resolve();
		});
	});
	host.addTransport({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
	const address = server.address();
	return typeof address === "object" && address ? address.port : port;
}

export function openTcpLink(host: string, port: number, handlers: LinkHandlers): GuestLink {
	const socket = connect({ host, port });
	socket.setEncoding("utf8");
	socket.setNoDelay(true);
	const decoder = new FrameDecoder();
	socket.on("connect", handlers.onOpen);
	socket.on("data", (chunk: string) => {
		try {
			for (const frame of decoder.push(chunk)) handlers.onMessage(frame as ServerMessage);
		} catch {
			socket.destroy();
		}
	});
	socket.on("error", (error) => handlers.onError(error.message));
	socket.on("close", handlers.onClose);
	return {
		send: (message: ClientMessage) => {
			if (!socket.destroyed) socket.write(encodeFrame(message));
		},
		close: () => socket.end(),
	};
}
