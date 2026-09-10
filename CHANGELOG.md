# Changelog

## [1.29.0](https://github.com/engram-app/Engram-obsidian/compare/1.28.0...1.29.0) (2026-09-09)


### Features

* **sync:** report plugin version, and surface the backend's version floor ([#512](https://github.com/engram-app/Engram-obsidian/issues/512)) ([12130c1](https://github.com/engram-app/Engram-obsidian/commit/12130c108391ae02f7258040e95dcf641638dd89))


### Bug Fixes

* **diagnostics:** hash vault paths before remote logging ([#510](https://github.com/engram-app/Engram-obsidian/issues/510)) ([45fdc3d](https://github.com/engram-app/Engram-obsidian/commit/45fdc3d8236bcce509058fa8398fde6c114b2b2a))

## [1.28.0](https://github.com/engram-app/Engram-obsidian/compare/1.27.0...1.28.0) (2026-09-05)


### Features

* **settings:** add the setup video to the Welcome tab and README ([#506](https://github.com/engram-app/Engram-obsidian/issues/506)) ([b3e95cb](https://github.com/engram-app/Engram-obsidian/commit/b3e95cb59ef6b4b34b7a726626a7e55967e5d584))

## [1.27.0](https://github.com/engram-app/Engram-obsidian/compare/1.26.0...1.27.0) (2026-09-05)


### Features

* **crdt:** record a room-free delivery so it stops taking a room ([#500](https://github.com/engram-app/Engram-obsidian/issues/500)) ([7a62a21](https://github.com/engram-app/Engram-obsidian/commit/7a62a210dc824749c1b6c2a6aeb05cafc9171761))
* drop the waitlist prompt, send new users to sign-up ([#504](https://github.com/engram-app/Engram-obsidian/issues/504)) ([17ab8a8](https://github.com/engram-app/Engram-obsidian/commit/17ab8a8eb81ec0e4dddd41b66f7d51534b6ed2a8))
* **sync-center:** surface notes that synced but are not searchable ([#503](https://github.com/engram-app/Engram-obsidian/issues/503)) ([91e9c97](https://github.com/engram-app/Engram-obsidian/commit/91e9c975d07aedab62d939723b1d3ea9e8d21010))


### Bug Fixes

* **copy:** purge dead limit reasons and stale plan claims ([#502](https://github.com/engram-app/Engram-obsidian/issues/502)) ([a2049ee](https://github.com/engram-app/Engram-obsidian/commit/a2049eea92f681ccaeda378ec621ca5d5c245757))

## [1.26.0](https://github.com/engram-app/Engram-obsidian/compare/1.25.0...1.26.0) (2026-09-02)


### Features

* **crdt:** deliver queued edits for idle notes without a room ([#496](https://github.com/engram-app/Engram-obsidian/issues/496)) ([05d3223](https://github.com/engram-app/Engram-obsidian/commit/05d3223187f27d0702606691042b4820d4d9151e))


### Bug Fixes

* **crdt:** a tombstoned id must not start a reconcile ([#492](https://github.com/engram-app/Engram-obsidian/issues/492)) ([4d6eccc](https://github.com/engram-app/Engram-obsidian/commit/4d6eccc55bac5d09060a5da3172f1c1e86d26a7a))
* **crdt:** re-drive the create for an orphaned index claim ([#497](https://github.com/engram-app/Engram-obsidian/issues/497)) ([421d4fd](https://github.com/engram-app/Engram-obsidian/commit/421d4fdc871665ffe39d85f13cf7b6f4eb84cf48))
* **crdt:** review follow-ups on room-free queue delivery ([#498](https://github.com/engram-app/Engram-obsidian/issues/498)) ([570a7fb](https://github.com/engram-app/Engram-obsidian/commit/570a7fba612d412c28353d58b1d23a5ec2c47a06))
* **crdt:** table-cell editor corruption + trim redundant sync status surfaces ([#487](https://github.com/engram-app/Engram-obsidian/issues/487)) ([296b08e](https://github.com/engram-app/Engram-obsidian/commit/296b08e18c0f86efc5fc3fe38d73a9964810ee93))
* **sync:** a rename carries the note's sync evidence ([#490](https://github.com/engram-app/Engram-obsidian/issues/490)) ([43194b3](https://github.com/engram-app/Engram-obsidian/commit/43194b39456bfbaebd57ebed8e17d71372c9d6de))

## [1.25.0](https://github.com/engram-app/Engram-obsidian/compare/1.24.3...1.25.0) (2026-08-30)


### Features

* **search:** tell Free users which notes are outside the index cap ([#481](https://github.com/engram-app/Engram-obsidian/issues/481)) ([a56a8d1](https://github.com/engram-app/Engram-obsidian/commit/a56a8d1533df19536a0ea013384ae0a296b9d93a))


### Bug Fixes

* **crdt:** don't converge a note whose local file is empty ([#477](https://github.com/engram-app/Engram-obsidian/issues/477)) ([#478](https://github.com/engram-app/Engram-obsidian/issues/478)) ([649f3f5](https://github.com/engram-app/Engram-obsidian/commit/649f3f513381667e8e12bb5b11382935ee1f8d24))
* **crdt:** drop the dead phantom-binding repair ([#484](https://github.com/engram-app/Engram-obsidian/issues/484)) ([#485](https://github.com/engram-app/Engram-obsidian/issues/485)) ([806c478](https://github.com/engram-app/Engram-obsidian/commit/806c47871d25458676ca7905e41564b433b0eff8))
* **crdt:** never mint over a live committed claim ([#482](https://github.com/engram-app/Engram-obsidian/issues/482)) ([0f7f535](https://github.com/engram-app/Engram-obsidian/commit/0f7f535dda43cbd3fea4f0170d000d78f18f2ac1))
* **push:** don't drop a real edit when the mint is refused ([#486](https://github.com/engram-app/Engram-obsidian/issues/486)) ([7a80841](https://github.com/engram-app/Engram-obsidian/commit/7a80841bd451131b379be8dba4d1baf95ec9bdeb))

## [1.24.3](https://github.com/engram-app/Engram-obsidian/compare/1.24.2...1.24.3) (2026-08-26)


### Bug Fixes

* **auth:** stop offering API keys to tiers that cannot use them ([#470](https://github.com/engram-app/Engram-obsidian/issues/470)) ([9809720](https://github.com/engram-app/Engram-obsidian/commit/9809720a19565e59461c4f099ae650c3ab4ca873))
* **crdt:** [#1409](https://github.com/engram-app/Engram-obsidian/issues/1409) — room-free cold-note convergence, per-vault identity, and two path consolidations ([#474](https://github.com/engram-app/Engram-obsidian/issues/474)) ([c39d2a4](https://github.com/engram-app/Engram-obsidian/commit/c39d2a401c0db2b8888f46769bf7048f719e85bb))
* **crdt:** gate create-ack self-heal enroll on isLiveBound ([#1409](https://github.com/engram-app/Engram-obsidian/issues/1409)) ([#466](https://github.com/engram-app/Engram-obsidian/issues/466)) ([0925c40](https://github.com/engram-app/Engram-obsidian/commit/0925c403cea65f970ace2cc931bbb7c6d196cad2))
* **sync:** close pushFile's TOCTOU reentrancy race ([#467](https://github.com/engram-app/Engram-obsidian/issues/467)) ([cf48339](https://github.com/engram-app/Engram-obsidian/commit/cf483399bdbc7bf734afa997c9500fd09b3e79dc))

## [1.24.2](https://github.com/engram-app/Engram-obsidian/compare/1.24.1...1.24.2) (2026-08-24)


### Bug Fixes

* **crdt:** stop the genesis history probe pinning a Y.Doc per note ([#464](https://github.com/engram-app/Engram-obsidian/issues/464)) ([867495e](https://github.com/engram-app/Engram-obsidian/commit/867495e550f3efc2c72c3b259e8537467e460024)), closes [#1409](https://github.com/engram-app/Engram-obsidian/issues/1409)

## [1.24.1](https://github.com/engram-app/Engram-obsidian/compare/1.24.0...1.24.1) (2026-08-23)


### Bug Fixes

* **crdt:** never ship a genesis frame for a note this device already has ([#460](https://github.com/engram-app/Engram-obsidian/issues/460)) ([efa4966](https://github.com/engram-app/Engram-obsidian/commit/efa4966df3503ab243a9a4305ed493e91b40d0ed))
* **device-flow:** stop the resume probe stalling the desktop link flow ([#461](https://github.com/engram-app/Engram-obsidian/issues/461)) ([91a01c9](https://github.com/engram-app/Engram-obsidian/commit/91a01c9012ebff6b3572b4c8680e4a576ddeac13))
* first-time connect and link UX ([#458](https://github.com/engram-app/Engram-obsidian/issues/458)) ([23bb305](https://github.com/engram-app/Engram-obsidian/commit/23bb3054bdb9196b95f0f1ef48b2475236f68fcc))
* **sync:** skip the blob fetch when we already hold the bytes; don't fail a push on reconcile ([#463](https://github.com/engram-app/Engram-obsidian/issues/463)) ([41cec4f](https://github.com/engram-app/Engram-obsidian/commit/41cec4f0737e507b35e484157d2828ad0d33f347))
* **sync:** stop re-uploading attachments the server already holds ([#462](https://github.com/engram-app/Engram-obsidian/issues/462)) ([d5cf0cc](https://github.com/engram-app/Engram-obsidian/commit/d5cf0cc31580990b14d0701def5ad43ead360cdd))

## [1.24.0](https://github.com/engram-app/Engram-obsidian/compare/1.23.1...1.24.0) (2026-08-20)


### Features

* **crdt:** send the genesis body with crdt_create ([#452](https://github.com/engram-app/Engram-obsidian/issues/452)) ([e557e35](https://github.com/engram-app/Engram-obsidian/commit/e557e35751b7c381af1102e7c0b90e052fd75926)), closes [#1409](https://github.com/engram-app/Engram-obsidian/issues/1409)


### Bug Fixes

* **crdt:** stop reporting a refused index frame as delivered ([#450](https://github.com/engram-app/Engram-obsidian/issues/450)) ([d64ffc8](https://github.com/engram-app/Engram-obsidian/commit/d64ffc80c92e6c83011cdf5a8661975bb39327f6))
* **plan:** drop the plan verdict when the server changes ([#457](https://github.com/engram-app/Engram-obsidian/issues/457)) ([bc0a404](https://github.com/engram-app/Engram-obsidian/commit/bc0a404f0a5730946b4a52fcd0a7b5f67ecde1ac))
* **sync:** probe the empty-trust guard by id, not by event.path ([#449](https://github.com/engram-app/Engram-obsidian/issues/449)) ([fb4d70b](https://github.com/engram-app/Engram-obsidian/commit/fb4d70b3bd7e5264a0520b95fca9457a4679c932))
* **sync:** stop offering freshly pulled notes back as uploads ([#454](https://github.com/engram-app/Engram-obsidian/issues/454)) ([f4895ea](https://github.com/engram-app/Engram-obsidian/commit/f4895ea6050487cb52c4dbe38b84cf39f19533fd))
* **vault:** stop one sync creating two vaults ([#456](https://github.com/engram-app/Engram-obsidian/issues/456)) ([5a68e60](https://github.com/engram-app/Engram-obsidian/commit/5a68e60cb644adb70467bad5d9c832442e72b2d2))

## [1.23.1](https://github.com/engram-app/Engram-obsidian/compare/1.23.0...1.23.1) (2026-08-18)


### Bug Fixes

* **sync:** a freshly minted note_id is never server-known ([#447](https://github.com/engram-app/Engram-obsidian/issues/447)) ([20d9ea1](https://github.com/engram-app/Engram-obsidian/commit/20d9ea1021c0fc2010f69ac31ba6cd737f5c1b83))

## [1.23.0](https://github.com/engram-app/Engram-obsidian/compare/1.22.0...1.23.0) (2026-08-18)


### Features

* **crdt:** client half of the index CRDT — SyncStore over filemeta_v0 ([#431](https://github.com/engram-app/Engram-obsidian/issues/431)) ([d0a6c99](https://github.com/engram-app/Engram-obsidian/commit/d0a6c9944aea3f75d63fb18829583652796a4480))
* **device-flow:** carry the code in the verification URL ([#428](https://github.com/engram-app/Engram-obsidian/issues/428)) ([2623680](https://github.com/engram-app/Engram-obsidian/commit/2623680b58d1df137b6503f3cc2527180703ae0c))


### Bug Fixes

* **privacy:** delete the unquoted-path regex, redact the known path exactly ([#438](https://github.com/engram-app/Engram-obsidian/issues/438)) ([99c1953](https://github.com/engram-app/Engram-obsidian/commit/99c1953df2fc6d147483692e414e8ed46d0d28a2))
* **privacy:** scrub unquoted vault paths from error messages ([#437](https://github.com/engram-app/Engram-obsidian/issues/437)) ([fdc13d0](https://github.com/engram-app/Engram-obsidian/commit/fdc13d01e3b7cd6bc479d64f0acdc09d9a66a935))
* **privacy:** stop logging vault paths ([#436](https://github.com/engram-app/Engram-obsidian/issues/436)) ([b21f9a3](https://github.com/engram-app/Engram-obsidian/commit/b21f9a36cda29bdf0c2d292315904687e5ca7c16))
* **sync:** a remote rename must move the note, not destroy and rebuild it ([#441](https://github.com/engram-app/Engram-obsidian/issues/441)) ([3ff7038](https://github.com/engram-app/Engram-obsidian/commit/3ff7038587a66295669102400e9f0161133be5a5))
* **sync:** first-sync progress stream and server oracle ([#424](https://github.com/engram-app/Engram-obsidian/issues/424)) ([7a90941](https://github.com/engram-app/Engram-obsidian/commit/7a90941694341931772edc8d0630c5d81554c0fd))

## [1.22.0](https://github.com/engram-app/Engram-obsidian/compare/1.21.0...1.22.0) (2026-08-13)


### Features

* **sync:** one-click first sync when one side is empty ([#415](https://github.com/engram-app/Engram-obsidian/issues/415)) ([96cc320](https://github.com/engram-app/Engram-obsidian/commit/96cc320d3d8d4359bdee15435b633acd3b6e31e7))


### Bug Fixes

* **auth:** dispose replaced OAuth providers so token chains never fork ([#421](https://github.com/engram-app/Engram-obsidian/issues/421)) ([fb51656](https://github.com/engram-app/Engram-obsidian/commit/fb51656d139b739f9f389d7cb5294d9df0f3bfbc))
* honest failure UX + accurate first-sync progress ([#422](https://github.com/engram-app/Engram-obsidian/issues/422)) ([fd5663e](https://github.com/engram-app/Engram-obsidian/commit/fd5663ed9e816c1298693fcf8d023d1c0ce4ee76))
* **sync:** close every delete-push bypass the post-merge review found ([#419](https://github.com/engram-app/Engram-obsidian/issues/419)) ([c9d8c7d](https://github.com/engram-app/Engram-obsidian/commit/c9d8c7d26f8ea8d7a2c9fe8316bbc56d12b2322b))
* **sync:** delete-push fence — engine trashes and unsynced paths never delete server data ([#417](https://github.com/engram-app/Engram-obsidian/issues/417)) ([8a4b075](https://github.com/engram-app/Engram-obsidian/commit/8a4b0750d45d2e37141b8107a5a030b209511075)), closes [#416](https://github.com/engram-app/Engram-obsidian/issues/416)
* **sync:** report first-sync progress in file units ([#412](https://github.com/engram-app/Engram-obsidian/issues/412)) ([e60b478](https://github.com/engram-app/Engram-obsidian/commit/e60b4788af8214afb5f94de819cfbb91f21aef8a))

## [1.21.0](https://github.com/engram-app/Engram-obsidian/compare/1.20.1...1.21.0) (2026-08-09)


### Features

* **ci:** announce releases to the announcements channel, with a cap ([#398](https://github.com/engram-app/Engram-obsidian/issues/398)) ([e52a3d3](https://github.com/engram-app/Engram-obsidian/commit/e52a3d3d879e49686ee37b73bff340df539d4854))
* **settings:** merge Cloud and Self-hosted into one Connection tab ([#408](https://github.com/engram-app/Engram-obsidian/issues/408)) ([e2d70cc](https://github.com/engram-app/Engram-obsidian/commit/e2d70cc48223c863dac854fd6746c8ae3db21d5e))


### Bug Fixes

* **ci:** reconcile orphaned preview releases instead of trusting one event ([#397](https://github.com/engram-app/Engram-obsidian/issues/397)) ([289d234](https://github.com/engram-app/Engram-obsidian/commit/289d234dc1083ec120f9ab786c67835d7ec88188))
* **ci:** reconcile preview TAGS that outlived their release ([#400](https://github.com/engram-app/Engram-obsidian/issues/400)) ([d9c6b37](https://github.com/engram-app/Engram-obsidian/commit/d9c6b375d3fbc1448b7e7d51487df17b54418cf1))
* **deps:** raise the js-yaml override past GHSA-5p4m-2wfm-xmqj ([#402](https://github.com/engram-app/Engram-obsidian/issues/402)) ([519a202](https://github.com/engram-app/Engram-obsidian/commit/519a2027dcdfe9b83a1894afaa724ffca711f000))
* **sync:** drop the outbound CRDT work on a vault change ([#409](https://github.com/engram-app/Engram-obsidian/issues/409)) ([e67f199](https://github.com/engram-app/Engram-obsidian/commit/e67f1998e820aacf824c7b75f580b688ab5f2b61))
* **sync:** stamp outbound CRDT ops with their vault instead of wiping the outbox ([#410](https://github.com/engram-app/Engram-obsidian/issues/410)) ([81a32ba](https://github.com/engram-app/Engram-obsidian/commit/81a32ba33692c613a7f73e882baa9605c4300d6d))

## [1.20.1](https://github.com/engram-app/Engram-obsidian/compare/1.20.0...1.20.1) (2026-08-06)


### Bug Fixes

* **crdt:** stop dropping inserts at the frontmatter boundary (first-line typing corruption) ([#396](https://github.com/engram-app/Engram-obsidian/issues/396)) ([9d4f1e4](https://github.com/engram-app/Engram-obsidian/commit/9d4f1e4a7b5fca404e7a15b4c22a5e69de0f2d56))
* **sync:** id-keyed move must not discard content over an EMPTY target ([#394](https://github.com/engram-app/Engram-obsidian/issues/394)) ([efee0b6](https://github.com/engram-app/Engram-obsidian/commit/efee0b6d088de414e244f7edbca6e99090ad2899))

## [1.20.0](https://github.com/engram-app/Engram-obsidian/compare/1.19.0...1.20.0) (2026-08-05)


### Features

* **crdt:** make LCA three-way merge the default path ([#368](https://github.com/engram-app/Engram-obsidian/issues/368)) ([90b2127](https://github.com/engram-app/Engram-obsidian/commit/90b21279cc73b2284cfcbe08799f2dc81dd69bae)), closes [#364](https://github.com/engram-app/Engram-obsidian/issues/364)
* tag crdt join with client_type obsidian ([#389](https://github.com/engram-app/Engram-obsidian/issues/389)) ([a8ad8ab](https://github.com/engram-app/Engram-obsidian/commit/a8ad8abf858794134a96dc5465206e8bce94c752))


### Bug Fixes

* **deps:** clear three new audit advisories ([#385](https://github.com/engram-app/Engram-obsidian/issues/385)) ([a04129e](https://github.com/engram-app/Engram-obsidian/commit/a04129e120e658f5baf6c4125df3322924a11a24))
* repo-review remediation — safety/correctness fixes, dead-code purge, DRY consolidation ([#374](https://github.com/engram-app/Engram-obsidian/issues/374)) ([1baf9ad](https://github.com/engram-app/Engram-obsidian/commit/1baf9adacbe61d6c198bef69896ae14be39b4a97))
* **settings:** isConnected guard on the progress bar ([#379](https://github.com/engram-app/Engram-obsidian/issues/379)) ([bcaad06](https://github.com/engram-app/Engram-obsidian/commit/bcaad06913f4b8bc2e5cee6af9bc350531233fbd)), closes [#375](https://github.com/engram-app/Engram-obsidian/issues/375)

## [1.19.0](https://github.com/engram-app/Engram-obsidian/compare/1.18.1...1.19.0) (2026-07-31)


### Features

* adopt six Relay sync patterns (audit wave) ([40e4012](https://github.com/engram-app/Engram-obsidian/commit/40e40122474cd2a1ad6be4e0321d00c9daf670fd)), closes [#355](https://github.com/engram-app/Engram-obsidian/issues/355) [#356](https://github.com/engram-app/Engram-obsidian/issues/356) [#357](https://github.com/engram-app/Engram-obsidian/issues/357) [#358](https://github.com/engram-app/Engram-obsidian/issues/358) [#359](https://github.com/engram-app/Engram-obsidian/issues/359) [#360](https://github.com/engram-app/Engram-obsidian/issues/360)
* **logging:** remoteLogLevel severity threshold for RemoteLogger ([#333](https://github.com/engram-app/Engram-obsidian/issues/333)) ([c884067](https://github.com/engram-app/Engram-obsidian/commit/c8840670b5c476d72484a96a0bde4ef297cd77c5))


### Bug Fixes

* **crdt:** classify handshake frames, ungate the syncStep2 reply too ([#337](https://github.com/engram-app/Engram-obsidian/issues/337)) ([61fa5d0](https://github.com/engram-app/Engram-obsidian/commit/61fa5d0104a4f4be0e6f8fe262fb5274a433de33))
* **crdt:** delete-time artifacts, Relay correctness primitives, and verbose logs that reach Loki ([#348](https://github.com/engram-app/Engram-obsidian/issues/348)) ([67dd39b](https://github.com/engram-app/Engram-obsidian/commit/67dd39bb9cea6bec553ebfcff2e8559d00a50a6d))
* stop the push debounce leaking a phantom pending entry ([#352](https://github.com/engram-app/Engram-obsidian/issues/352)) ([312faa7](https://github.com/engram-app/Engram-obsidian/commit/312faa7f4f32f97c6bf530730822db9c5f18430b))
* **sync:** sweep per-note CRDT maps in destroy() ([#366](https://github.com/engram-app/Engram-obsidian/issues/366)) ([f58b8c1](https://github.com/engram-app/Engram-obsidian/commit/f58b8c1126ee7a75fbbceeab94c76d272f36ff9f)), closes [#290](https://github.com/engram-app/Engram-obsidian/issues/290)

## [1.18.1](https://github.com/engram-app/Engram-obsidian/compare/1.18.0...1.18.1) (2026-07-26)


### Bug Fixes

* **auth:** never send a request with an empty bearer token ([#336](https://github.com/engram-app/Engram-obsidian/issues/336)) ([ffe55b9](https://github.com/engram-app/Engram-obsidian/commit/ffe55b992a221c7c01eb68ca14e6263daa3e89cc))
* **crdt:** never gate the syncStep1 pull on the create-ack ([#335](https://github.com/engram-app/Engram-obsidian/issues/335)) ([cba7e14](https://github.com/engram-app/Engram-obsidian/commit/cba7e14b23fba1c57db32176b8d83c252396f665))
* **crdt:** rebuild client on Relay's model ([#331](https://github.com/engram-app/Engram-obsidian/issues/331)) ([6a0e81d](https://github.com/engram-app/Engram-obsidian/commit/6a0e81da33285748f75e02670f02a05c19ceb858))
* **crdt:** recover offline edits after switch-away ([#325](https://github.com/engram-app/Engram-obsidian/issues/325)) ([3b87e48](https://github.com/engram-app/Engram-obsidian/commit/3b87e4877e8b18077f1018c833207dd2733276b7))

## [1.18.0](https://github.com/engram-app/Engram-obsidian/compare/1.17.0...1.18.0) (2026-07-25)


### Features

* **crdt:** canvas onto CRDT — structural Yjs sync ([#306](https://github.com/engram-app/Engram-obsidian/issues/306) Phase B, plugin) ([#321](https://github.com/engram-app/Engram-obsidian/issues/321)) ([65335e9](https://github.com/engram-app/Engram-obsidian/commit/65335e905f69f70b34cc0603ef0b908e5c35a927))
* modal-free drift-conflict-copy for CRDT md double-divergence (refs [#306](https://github.com/engram-app/Engram-obsidian/issues/306)) ([#320](https://github.com/engram-app/Engram-obsidian/issues/320)) ([c71b15b](https://github.com/engram-app/Engram-obsidian/commit/c71b15bd60bda75f4459d33bbdbb36f94dcb983f))
* sync preview on the op-log socket feed (redo of [#311](https://github.com/engram-app/Engram-obsidian/issues/311), startup + vault-switch fixed) ([#314](https://github.com/engram-app/Engram-obsidian/issues/314)) ([e7c9c87](https://github.com/engram-app/Engram-obsidian/commit/e7c9c87afefd5e8fe4fe9d3a9fb8747cc14c9256))
* sync preview on the op-log socket feed; delete /notes/changes + /attachments/changes client path ([#311](https://github.com/engram-app/Engram-obsidian/issues/311)) ([bb25db0](https://github.com/engram-app/Engram-obsidian/commit/bb25db0c36cc5a95fef29d22a70547d3a5d73fd2))
* thread + persist the composite {seq,id} catch-up cursor ([#312](https://github.com/engram-app/Engram-obsidian/issues/312)) ([#315](https://github.com/engram-app/Engram-obsidian/issues/315)) ([f1ccc95](https://github.com/engram-app/Engram-obsidian/commit/f1ccc95727a25f18d648852349e9b91a7e3dda57))


### Bug Fixes

* CRDT error guards — replay mint refusal, enrollment retry, frame/flush logging ([#302](https://github.com/engram-app/Engram-obsidian/issues/302)) ([b3ef617](https://github.com/engram-app/Engram-obsidian/commit/b3ef617eae8be972506c1a4db9372c2bfe1e2781))
* **deps:** clear brace-expansion audit via bx5 + minimatch10 overrides ([#324](https://github.com/engram-app/Engram-obsidian/issues/324)) ([13f9b21](https://github.com/engram-app/Engram-obsidian/commit/13f9b212994617602188069f9bcc7946303d79c9))
* release the transient heal room after convergence commits (e2e fan-out flake root cause) ([#307](https://github.com/engram-app/Engram-obsidian/issues/307)) ([014879a](https://github.com/engram-app/Engram-obsidian/commit/014879abf4f25fdc74de0d2406f3256d83d22007))
* **sync:** guard delete-reconcile against identity-swap race ([#283](https://github.com/engram-app/Engram-obsidian/issues/283)) ([#316](https://github.com/engram-app/Engram-obsidian/issues/316)) ([ee5a8f9](https://github.com/engram-app/Engram-obsidian/commit/ee5a8f92f83844368d2e8f212dc6f3b0fd4a85bb))

## [1.17.0](https://github.com/engram-app/Engram-obsidian/compare/1.16.0...1.17.0) (2026-07-23)


### Features

* **settings:** adopt getSettingDefinitions (Obsidian 1.13 search) ([#286](https://github.com/engram-app/Engram-obsidian/issues/286)) ([797b340](https://github.com/engram-app/Engram-obsidian/commit/797b340a1170f4be6e30342cfeb2faba6259810c))


### Bug Fixes

* **crdt:** skip remote-merge flush of empty body on never-seeded doc ([#288](https://github.com/engram-app/Engram-obsidian/issues/288)) ([#289](https://github.com/engram-app/Engram-obsidian/issues/289)) ([7990494](https://github.com/engram-app/Engram-obsidian/commit/79904944cbea572846764639086ab32fb09e6076))

## [1.16.0](https://github.com/engram-app/Engram-obsidian/compare/1.15.0...1.16.0) (2026-07-23)


### Features

* **sim:** deterministic CRDT convergence sim tier — differential gate for [#282](https://github.com/engram-app/Engram-obsidian/issues/282) ([#294](https://github.com/engram-app/Engram-obsidian/issues/294)) ([64c284d](https://github.com/engram-app/Engram-obsidian/commit/64c284d14789b3ac8427bee4ba88a3b75a69e2f0))
* **sim:** model editor enrollment → history-full notes; re-enable seeded random convergence suite ([#298](https://github.com/engram-app/Engram-obsidian/issues/298)) ([b7da6c8](https://github.com/engram-app/Engram-obsidian/commit/b7da6c869c561ffcd9b94b3716046527d33397c7))


### Bug Fixes

* **sync:** content-hash-aware equal-seq fence — an equal-seq row with new content is no longer dropped ([#296](https://github.com/engram-app/Engram-obsidian/issues/296)) ([fd1095a](https://github.com/engram-app/Engram-obsidian/commit/fd1095a9ae111f2636b9d657f9ec05bfafa735ab))

## [1.15.0](https://github.com/engram-app/Engram-obsidian/compare/1.14.0...1.15.0) (2026-07-22)


### Features

* delete the REST Yjs transport — socket is the only delta path (Phase E3) ([#293](https://github.com/engram-app/Engram-obsidian/issues/293)) ([f78ae97](https://github.com/engram-app/Engram-obsidian/commit/f78ae97e65db862b8f33cee5ec71ac03611817b5))
* **sync:** rename is one create op — delete the tombstone-resurrect dance (Phase E2) ([#292](https://github.com/engram-app/Engram-obsidian/issues/292)) ([f9087eb](https://github.com/engram-app/Engram-obsidian/commit/f9087ebafd66cd87c7008646d931eb5d746c123e))
* **sync:** seq gap-heal — live ops self-heal missed deliveries (pairs backend [#1058](https://github.com/engram-app/Engram-obsidian/issues/1058)) ([#278](https://github.com/engram-app/Engram-obsidian/issues/278)) ([a40092a](https://github.com/engram-app/Engram-obsidian/commit/a40092a4e54ddf0841f58e8948bd2f303bbe753e))
* **sync:** seq-diff vault validator — integer diff, bounded re-serve, head-equality heal skip (Phase E1) ([#291](https://github.com/engram-app/Engram-obsidian/issues/291)) ([f793df5](https://github.com/engram-app/Engram-obsidian/commit/f793df5b7c946877c45043bdb80c26b281c9a350))
* **sync:** socket-native live-bound converge — delete the REST backstop (single-path D3) ([#284](https://github.com/engram-app/Engram-obsidian/issues/284)) ([0007287](https://github.com/engram-app/Engram-obsidian/commit/0007287a862e85faed858989558ea469a1f8ccb5))


### Bug Fixes

* **api:** bound the five direct requestUrl call sites ([#279](https://github.com/engram-app/Engram-obsidian/issues/279)) ([6c572b0](https://github.com/engram-app/Engram-obsidian/commit/6c572b0f740b158c61329d7fdb830d1191b27883))
* **crdt:** deliver the vault fan-out to live-bound notes ([#264](https://github.com/engram-app/Engram-obsidian/issues/264)) ([689ee6d](https://github.com/engram-app/Engram-obsidian/commit/689ee6d887288439e8e8ce3f17304f553d977bb1))
* **sync:** converge CRDT backfill via Yjs deltas ([#281](https://github.com/engram-app/Engram-obsidian/issues/281)) ([fc44075](https://github.com/engram-app/Engram-obsidian/commit/fc440757c4e5875c21c3bf68f8bb17df2b6c2784))

## [1.14.0](https://github.com/engram-app/Engram-obsidian/compare/1.13.2...1.14.0) (2026-07-21)


### Features

* **crdt:** create-before-edit — gate live send on create-ack (single-path D1) ([#266](https://github.com/engram-app/Engram-obsidian/issues/266)) ([dcaa5bb](https://github.com/engram-app/Engram-obsidian/commit/dcaa5bb417ac86cf12b84e4a6750a4b2404ea54c))


### Bug Fixes

* **ci:** enforce the no-bump rule and repo-qualify gh in the release job ([#273](https://github.com/engram-app/Engram-obsidian/issues/273)) ([55239b8](https://github.com/engram-app/Engram-obsidian/commit/55239b8c3769cb5fd3d4a2521885eb91d3010c82))

## [1.13.2](https://github.com/engram-app/Engram-obsidian/compare/1.13.0...1.13.2) (2026-07-21)


### Bug Fixes

* align local lint with the community scanner ([#271](https://github.com/engram-app/Engram-obsidian/issues/271)) ([0ae6a84](https://github.com/engram-app/Engram-obsidian/commit/0ae6a84b6e75a06bdd98425b4ab96f1812a14c57))
* **release:** guard fromJson so a release run does not fail the job ([#268](https://github.com/engram-app/Engram-obsidian/issues/268)) ([db51de9](https://github.com/engram-app/Engram-obsidian/commit/db51de9c7ef24c313523ce1d655e8c43e71dac0f))

## [1.13.0](https://github.com/engram-app/Engram-obsidian/compare/1.12.33...1.13.0) (2026-07-21)


### Features

* **release:** three-channel plugin release pipeline (per-PR / beta / stable) ([#250](https://github.com/engram-app/Engram-obsidian/issues/250)) ([555d14d](https://github.com/engram-app/Engram-obsidian/commit/555d14d803ac861cb479b4594ef5478c9fd1fa9a))


### Bug Fixes

* make bun.lock portable so the Obsidian scanner can resolve types ([#262](https://github.com/engram-app/Engram-obsidian/issues/262)) ([87f732b](https://github.com/engram-app/Engram-obsidian/commit/87f732bf2e8d8d7547cdfbd50d3f6070c18eb9de))
* **release:** write versions.json into the release PR, not post-merge ([#263](https://github.com/engram-app/Engram-obsidian/issues/263)) ([156abac](https://github.com/engram-app/Engram-obsidian/commit/156abace022aa21ba1a7824a4f4b58936cacbbbf))
