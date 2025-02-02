/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

/** @typedef {import("http").ServerOptions} HttpServerOptions */
/** @typedef {import("https").ServerOptions} HttpsServerOptions */
/** @typedef {import("../../declarations/WebpackOptions").LazyCompilationDefaultBackendOptions} LazyCompilationDefaultBackendOptions */
/** @typedef {import("../Compiler")} Compiler */

/**
 * @callback BackendHandler
 * @param {Compiler} compiler compiler
 * @param {function(Error?, any?): void} callback callback
 * @returns {void}
 */

/**
 * @param {Omit<LazyCompilationDefaultBackendOptions, "client"> & { client: NonNullable<LazyCompilationDefaultBackendOptions["client"]>}} options additional options for the backend
 * @returns {BackendHandler} backend
 */
module.exports = options => (compiler, callback) => {
	const logger = compiler.getInfrastructureLogger("LazyCompilationBackend");
	const activeModules = new Map();
	const prefix = "/lazy-compilation-using-";

	const isHttps =
		options.protocol === "https" ||
		(typeof options.server === "object" &&
			("key" in options.server || "pfx" in options.server));

	const createServer =
		typeof options.server === "function"
			? options.server
			: (() => {
					const http = isHttps ? require("https") : require("http");
					return http.createServer.bind(http, options.server);
			  })();
	const listen =
		typeof options.listen === "function"
			? options.listen
			: server => server.listen(options.listen);

	const protocol = options.protocol || (isHttps ? "https" : "http");

	const requestListener = (req, res) => {
		const keys = req.url.slice(prefix.length).split("@");
		req.socket.on("close", () => {
			setTimeout(() => {
				for (const key of keys) {
					const oldValue = activeModules.get(key) || 0;
					activeModules.set(key, oldValue - 1);
					if (oldValue === 1) {
						logger.log(
							`${key} is no longer in use. Next compilation will skip this module.`
						);
					}
				}
			}, 120000);
		});
		req.socket.setNoDelay(true);
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"Access-Control-Allow-Origin": "*"
		});
		res.write("\n");
		let moduleActivated = false;
		for (const key of keys) {
			const oldValue = activeModules.get(key) || 0;
			activeModules.set(key, oldValue + 1);
			if (oldValue === 0) {
				logger.log(`${key} is now in use and will be compiled.`);
				moduleActivated = true;
			}
		}
		if (moduleActivated && compiler.watching) compiler.watching.invalidate();
	};

	const server = /** @type {import("net").Server} */ (createServer());
	server.on("request", requestListener);

	let isClosing = false;
	/** @type {Set<import("net").Socket>} */
	const sockets = new Set();
	server.on("connection", socket => {
		sockets.add(socket);
		socket.on("close", () => {
			sockets.delete(socket);
		});
		if (isClosing) socket.destroy();
	});
	server.on("clientError", e => {
		if (e.message !== "Server is disposing") logger.warn(e);
	});
	server.on("listening", err => {
		if (err) return callback(err);
		const addr = server.address();
		if (typeof addr === "string") throw new Error("addr must not be a string");
		const urlBase =
			addr.address === "::" || addr.address === "0.0.0.0"
				? `${protocol}://localhost:${addr.port}`
				: addr.family === "IPv6"
				? `${protocol}://[${addr.address}]:${addr.port}`
				: `${protocol}://${addr.address}:${addr.port}`;
		logger.log(
			`Server-Sent-Events server for lazy compilation open at ${urlBase}.`
		);
		callback(null, {
			dispose(callback) {
				isClosing = true;
				// Removing the listener is a workaround for a memory leak in node.js
				server.off("request", requestListener);
				server.close(err => {
					callback(err);
				});
				for (const socket of sockets) {
					socket.destroy(new Error("Server is disposing"));
				}
			},
			module(originalModule) {
				const key = `${encodeURIComponent(
					originalModule.identifier().replace(/\\/g, "/").replace(/@/g, "_")
				).replace(/%(2F|3A|24|26|2B|2C|3B|3D|3A)/g, decodeURIComponent)}`;
				const active = activeModules.get(key) > 0;
				return {
					client: `${options.client}?${encodeURIComponent(urlBase + prefix)}`,
					data: key,
					active
				};
			}
		});
	});
	listen(server);
};
