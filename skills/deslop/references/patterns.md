# AI writing pattern catalog

The tells that give away LLM-generated prose, grouped by type. Each entry: what it is,
why it reads as AI, and a before/after. Grounded in Wikipedia's "Signs of AI writing"
(maintained by WikiProject AI Cleanup) plus practitioner observations through 2026.

**How to use this:** scan for *clusters*, not isolated hits. A single em dash or one
"however" means nothing. Em dashes + rule-of-three + "vibrant tapestry" + a "Conclusion"
section is a confession. See the false-positive guard in `SKILL.md` before cutting.

---

## A. Content patterns

### A1. Significance / legacy inflation
Puffing up importance by claiming an arbitrary fact "represents," "marks," or
"contributes to" some broader trend. The single most common content tell.

Watch: *stands/serves as, is a testament/reminder, a pivotal/crucial/vital/key
moment/role, underscores its importance, reflects broader, symbolizing its enduring,
setting the stage for, marking a shift, key turning point, evolving landscape, indelible
mark, deeply rooted.*

> **AI:** established in 1989, marking a pivotal moment in the evolution of regional statistics
> **Human:** established in 1989 to publish regional statistics independently of the national office

### A2. Notability name-dropping
Proving importance by listing who covered the subject instead of what they said.

Watch: *independent coverage, local/regional/national media outlets, profiled in, featured
in, an active social media presence, written by a leading expert.*

> **AI:** Her views have been cited in the NYT, BBC, FT, and The Hindu. She maintains an active social media presence.
> **Human:** In a 2024 NYT interview, she argued AI regulation should target outcomes, not methods.

### A3. Superficial "-ing" analysis tails
Present-participle phrases tacked onto a sentence to fake depth. The written equivalent
of nodding sagely while saying nothing.

Watch: *highlighting…, underscoring…, emphasizing…, ensuring…, reflecting…, symbolizing…,
contributing to…, fostering…, showcasing….*

> **AI:** The palette of blue and gold resonates with the region, symbolizing the bluebonnets and reflecting the community's deep connection to the land.
> **Human:** The architect chose blue and gold to echo the local bluebonnets.

### A4. Promotional / travel-brochure language
Can't describe a place without "nestling" it somewhere "vibrant."

Watch: *boasts, vibrant, rich (figurative), profound, nestled, in the heart of, renowned,
breathtaking, must-visit, stunning, seamless, robust, world-class, state-of-the-art,
cutting-edge, groundbreaking (figurative).*

> **AI:** Nestled in the breathtaking Gonder region, a vibrant town with rich cultural heritage.
> **Human:** A town in Ethiopia's Gonder region, known for its weekly market and an 18th-century church.

### A5. Vague attributions / phantom authorities
Giving opinions weight by attributing them to no one in particular.

Watch: *industry reports, observers have cited, experts argue, some critics argue, research
suggests (uncited), it is widely believed.*

> **AI:** Experts believe it plays a crucial role in the regional ecosystem.
> **Human:** A 2019 Chinese Academy of Sciences survey recorded 12 endemic fish species in the river.

### A6. Formulaic "Challenges and Future" sections
Template: *Despite [good thing], [vague problems]. Despite these, [optimistic platitude].*

Watch: *Despite its…, faces several challenges…, Challenges and Legacy, Future Outlook,
Looking ahead, The road ahead.*

> **AI:** Despite its prosperity, the town faces challenges typical of urban areas. Despite these, it continues to thrive.
> **Human:** Traffic worsened after 2015, when three IT parks opened. A stormwater project began in 2022.

---

## B. Language & grammar

### B1. AI vocabulary words
A cluster of words that appears 3–10× more often in post-2023 text. The list *shifts by
model generation*; treat it as a smell, not a blocklist. Co-occurrence is the real signal.

Watch: *additionally, align with, bolster, crucial, delve, emphasize, enduring, enhance,
foster, garner, highlight (v.), interplay, intricate/intricacies, key (adj.), landscape
(abstract), leverage, multifaceted, notably, pivotal, realm, showcase, tapestry (abstract),
testament, underscore (v.), utilize, valuable, vibrant, moreover, furthermore, it's worth
noting, it's important to note, at the end of the day.*

> **AI:** An enduring testament to Italian influence is the adoption of pasta in the local culinary landscape.
> **Human:** Pasta, introduced under Italian colonization, is still common in the south.

### B2. Copula avoidance (dodging "is" / "has")
Substituting elaborate verbs for simple ones to sound sophisticated. Post-2023 text shows
a measurable drop in plain "is/are."

Watch: *serves as, stands as, marks, represents, boasts, features, offers* — where *is/are/has*
would do.

> **AI:** Gallery 825 serves as the exhibition space and boasts 3,000 square feet.
> **Human:** Gallery 825 is the exhibition space. It has 3,000 square feet.

### B3. Negative parallelism
"Not X, but Y." Once is fine. Twice is a pattern. Three times is a chatbot.

Watch: *Not only X but Y, It's not just about X — it's Y, It isn't merely X, it's Z.* Also
clipped tailing negations bolted on: *…no guessing, …no wasted motion.*

> **AI:** It's not just a song, it's a statement.
> **Human:** The heavy beat sets the aggressive tone.

### B4. Rule of three
Forcing ideas into triads to sound comprehensive. Humans don't always think in threes.

> **AI:** Attendees can expect innovation, inspiration, and industry insights.
> **Human:** The event has talks and panels, plus time to mingle.

### B5. Elegant variation (synonym / noun-phrase cycling)
Repetition penalties make models swap *protagonist → main character → central figure → hero*
within a paragraph. Humans just repeat the clearest word.

> **AI:** The artist faced obstacles. The non-conformist painter persisted. The visionary creator triumphed.
> **Human:** Yankilevsky faced obstacles but kept working.

### B6. False ranges
"From X to Y" where X and Y aren't on a real scale.

> **AI:** from the singularity of the Big Bang to the enigmatic dance of dark matter
> **Human:** The book covers the Big Bang, star formation, and dark-matter theories.

### B7. Passive voice hiding the actor
Dropped subjects: "No configuration file needed," "The results are preserved automatically."
Rewrite when active voice is clearer.

> **AI:** No configuration file needed. The results are preserved automatically.
> **Human:** You don't need a config file. The system saves results for you.

---

## C. Style & formatting

### C1. Em / en dashes — hard cut
The em dash (—) and en dash (–) are the single most reliable formatting tell. **The final
rewrite contains none.** This is a hard constraint, not a "use sparingly." Replace each, in
rough order of preference: a period (new sentence), a comma (tight aside), a colon
(introducing an explanation), or parentheses (true aside) — or restructure. Catch spaced
em dashes (` — `) and double hyphens (` -- `) too. Before returning, grep the draft for
`—` and `–`; any hit means it isn't done.

> **AI:** The policy — announced without warning — affects thousands.
> **Human:** The policy, announced without warning, affects thousands.

### C2. Boldface overuse / erratic inline bolding
Mechanically bolding terms, or sprinkling bold through running prose with no consistent rule.

> **AI:** Remote work has **fundamentally changed** how **many employees** view **flexible arrangements**.
> **Human:** Remote work changed how companies operate. Most employees now want flexibility.

### C3. Inline-header bullet lists
List items that start with a bolded header and a colon, where prose would flow better.

> **AI:**
> - **Performance:** Performance has improved through optimized algorithms.
> - **Security:** Security has been strengthened with encryption.
> **Human:** The update speeds up load times and adds end-to-end encryption.

### C4. Title Case In Headings
Capitalizing every main word in a heading.

> **AI:** ## Strategic Negotiations And Global Partnerships
> **Human:** ## Strategic negotiations and global partnerships

### C5. Emojis as formatting
🚀 / 💡 / ✅ decorating headers or bullets.

### C6. Curly quotes
"smart" quotes and apostrophes instead of straight ones. *Weak on its own* — most editors
auto-curl — but a tell in a cluster, and a fingerprint for some models.

### C7. Question-format section headings
FAQ-style titles in long-form prose: *What makes X unique? Why is Y important? How does Z work?*

---

## D. Communication / meta artifacts

### D1. Chatbot correspondence leaking into content
Conversational framing pasted verbatim.

Watch: *I hope this helps, Of course!, Certainly!, Here is an overview of…, Would you like me
to…, Let me know if…, In this article we will explore….*

> **AI:** Here is an overview of the French Revolution. I hope this helps!
> **Human:** The French Revolution began in 1789 amid financial crisis and food shortages.

### D2. Knowledge-cutoff disclaimers & speculative gap-filling
(a) Hard cutoff disclaimers. (b) When a model can't find a source, it writes a paragraph
*about* not finding one, then invents stock filler.

Watch: *as of my last update, while specific details are limited, based on available
information, maintains a low profile, keeps personal details private, likely grew up….*

> **AI:** Information about her early life is not publicly available, suggesting she keeps personal details private. She likely grew up in a middle-class household.
> **Human:** Her early life isn't documented in the available sources. *(Or cut the section.)*

### D3. Sycophantic / servile tone
> **AI:** Great question! You're absolutely right that this is a complex topic.
> **Human:** The economic factors you mentioned are relevant here.

---

## E. Filler & hedging

### E1. Filler phrases
*In order to* → *to*. *Due to the fact that* → *because*. *At this point in time* → *now*.
*Has the ability to* → *can*. *It is important to note that the data shows* → *the data shows*.

### E2. Excessive hedging
> **AI:** It could potentially possibly be argued that the policy might have some effect.
> **Human:** The policy may affect outcomes.

(Caution: in scientific writing, *some* hedging is legitimate caution — see the `scientific`
profile. Strip stacked hedges, keep honest uncertainty.)

### E3. Generic positive conclusions
> **AI:** The future looks bright. Exciting times lie ahead on this journey toward excellence.
> **Human:** The company plans two more locations next year.

### E4. Persuasive-authority tropes
Pretending to cut through to a deeper truth, then restating an ordinary point with ceremony.

Watch: *The real question is, at its core, in reality, what really matters, fundamentally,
the deeper issue, the heart of the matter.*

### E5. Signposting / announcements
Announcing the work instead of doing it: *Let's dive in, let's explore, let's break this
down, here's what you need to know, without further ado.*

### E6. Hyphenated-pair overuse
AI hyphenates uniformly, even in predicate position. Keep attributive hyphens (*a
high-quality report*); drop them after the noun (*the report is high quality*).

---

## F. Structural tells (the deeper ones)

These survive a surface clean. They're about how the *argument* is built.

### F1. The treadmill effect (low information density)
A 500-word AI passage may hold 100 words of content and 400 of restatement. Humans advance;
AI circles. Test each sentence: *what's actually new here?* Cut any that just rephrases.

Watch mid-paragraph: *In other words, Put simply, To put it another way, Essentially, That
is to say.* A paragraph that loses 60% of its words and reads better is the right outcome.

### F2. Paragraph-reshuffling immunity
AI generates parallel self-contained blocks, not an unfolding argument. Test: can you swap
paragraph 2 and paragraph 4 without breaking the piece? If yes, it's AI. Fix: make each
paragraph depend on something concrete in the one before (a callback, a "this is why").

### F3. Symbolic gloss / meaning-telling
Narrating what a fact *means* instead of trusting the fact. Distinct from A1: this is the
interpretive layer telling the reader what to feel.

Watch: *represents, symbolizes, speaks to, embodies, reflects broader,* applied to mundane things.

> **AI:** The closed factory represents the decline of American manufacturing and speaks to broader anxieties about post-industrial identity.
> **Human:** The factory closed in 2009. Three hundred jobs gone. The high school dropped football the next year.

### F4. Paragraph-closing "Whether…" summaries
Ending a paragraph with a recap line that restates its scope: *Whether you…, Whether it's….*
Cut it; end on the strongest specific point instead.

> **AI:** Tokyo offers everything from fine dining to street food. Whether you prefer Michelin stars or ramen stalls, Tokyo has something for every palate.
> **Human:** Tokyo's best ramen counter has no phone and no reservations. Same broth recipe since 1987.

### F5. Infomercial engagement hooks
Fake dramatic pauses from social-optimized writing: *The catch? The kicker? Here's the
thing. Here's what nobody tells you. Sound familiar?* Delete the hook; let the next line land.

### F6. Uniform sentence length (low burstiness)
Every sentence lands at 15–25 words. Human writing varies wildly — 3-word fragments next to
40-word runners. AI detectors literally measure this variance ("burstiness"). Mix short,
medium, and long; never 3+ similar-length sentences in a row. Fragments work. Really.

---

## G. Copy-paste artifacts (near-definitive tells)

If any of these appear, the text was almost certainly pasted from a chatbot. Always strip.

- **Citation markup leak:** `citeturn0search0`, `contentReference[oaicite:0]{index=0}`,
  `oai_citation`, `[attached_file:1]`, `grok_card`, `turn0search0`.
- **UTM tracking params** the tools append: `?utm_source=chatgpt.com`, `utm_source=openai`,
  `utm_source=copilot.com`, `referrer=grok.com`. Strip from URLs.
- **Placeholder / mad-libs templates** the author forgot to fill: `[Your Name]`,
  `[INSERT SOURCE]`, `2025-XX-XX`, `<!-- add if available -->`.
- **Sudden register shift:** one paragraph in flawless formal English next to casual text
  with errors — the seam between human and pasted-AT sections.

---

## H. Diff-anchored writing (for docs/code)
Documentation or comments written as if narrating a change rather than describing the thing
as it is. Unless the doc is version-scoped (changelog, release notes, migration guide), it
should read coherently without knowing the last commit.

> **AI:** This function was added to replace the previous approach of iterating through all items.
> **Human:** This function uses a hash map for O(1) lookups.
