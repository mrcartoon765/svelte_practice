/// <reference types="@sveltejs/kit" />
import { build, files, prerendered, version } from '$service-worker';

const CACHE = `cache-${version}`;
const ASSETS = [...build, ...files, ...prerendered];

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			// 1件でも失敗すると install 全体が止まるのを防ぐため個別に add
			await Promise.all(
				ASSETS.map(async (url) => {
					try {
						await cache.add(url);
					} catch (err) {
						console.warn('[sw] skip cache:', url, err);
					}
				})
			);
		})()
	);
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key !== CACHE) await caches.delete(key);
			}
			await self.clients.claim();
		})()
	);
});

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);

			// プリキャッシュ済みアセットはキャッシュ優先
			if (ASSETS.includes(url.pathname)) {
				const cached = await cache.match(url.pathname);
				if (cached) return cached;
			}

			// それ以外はネットワーク優先、200 & basic 応答のみキャッシュ（リダイレクトやopaqueは除外）
			try {
				const response = await fetch(request);
				if (response.status === 200 && response.type === 'basic' && !response.redirected) {
					cache.put(request, response.clone());
				}
				return response;
			} catch {
				const cached = await cache.match(request);
				if (cached) return cached;
				throw new Error('offline and not cached');
			}
		})()
	);
});
