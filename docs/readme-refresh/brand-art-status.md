# Brand art handoff status

Brand illustrations are not software screenshots or acceptance evidence. The
original `bamboo/docs/assets/bamboo-agent-hero.svg` is preserved. No generated
candidate has been integrated into a README or committed as an unreadable asset.

Earlier agent-core candidates could not be downloaded using the official Library
resolved-reference helper plus one retry. They were subsequently paused by the
user. The latest user direction is vitality and plant symbolism: bamboo resilience,
bodhi wisdom, lotus beauty and purity, early written records for Jiandu, and a
robotic identity for Nova, without eye-like motifs.

The user approved the nature series with “可以 请用这一套来更新”. These are now the **approved images awaiting actual transfer**, all version 0:

| Candidate | Supplied Library ID |
|---|---|
| Bamboo-nature-hero.png | `libfile_eee2863671c48191b7e392e65284b4af` |
| Bodhi-nature-hero.png | `libfile_5f6df38011e08191be5c5041bd2f6fd9` |
| Lotus-Next-nature-hero.png | `libfile_c268559f35908191aa4980dd6a42309e` |
| Nova-nature-hero.png | `libfile_7af0751522688191831d92dbb14184b9` |
| Jiandu-nature-hero.png | `libfile_e17dc44b591c81918c661bcf3e91d479` |

These identities are handoff metadata, not a claim that bytes, dimensions or text
have been inspected in this environment. The latest instruction explicitly says
not to repeat the known-failing download route. Actual image transfer and visual
QA must precede repository integration, with matching language variants and clear
illustration alt text. This pending byte transfer does not block the finished
README and real-recording deliverables.

## Supported transfer and exact integration plan

This executor exposes `download_file` for an ordinary authorized attachment's
exact `file_id` (maximum 32 MiB). No ordinary attachment file IDs for the approved
nature images have been supplied in this thread yet; a `libfile_` ID cannot be
substituted. This capability has not been tested on these five images.
No distinct cross-executor filesystem transfer tool or verified shared mount has
been exposed. Empty local scratch/shared directories do not establish such a route.
The known Library route failed and is not retried again.

After authorized bytes arrive and pass pixel/size inspection, use these paths:

| Module | Repository-relative asset | README files to update |
|---|---|---|
| Bamboo | `docs/assets/bamboo-nature-hero.png` | `README.md`, `README.zh-CN.md` |
| Bodhi | `docs/assets/bodhi-nature-hero.png` | `README.md`, `README.zh-CN.md` |
| Lotus Next | `docs/assets/lotus-next-nature-hero.png` | `README.md` |
| Nova | `docs/assets/nova-nature-hero.png` | `README.md` |
| Jiandu | `docs/assets/jiandu-nature-hero.png` | `README.md` |

Place each hero near the top and explicitly identify it as a brand illustration,
not a screenshot. English/Chinese alt text will be matched where both READMEs
exist. These are planned paths only: no nonexistent image reference is committed.
Preserve the old Bamboo SVG and use no eye-like agent-core candidate.
