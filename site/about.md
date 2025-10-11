# About Auto Minutes

Auto Minutes provides automatic minutes for IETF sessions.

<img src="/img/architecture.png" width="100%">

Auto Minutes takes the existing Meetecho session transcripts and turns
them into minutes, as shown in the diagram above.

Auto Minutes works one IETF plenary meeting at a time. It starts by
scraping the proceedings page,
([for instance](https://datatracker.ietf.org/meeting/123/proceedings)).
It extracts each "Session Recording" link and infers the link for the
transcript JSON from the URL, sending the transcript to an LLM
(currently mostly Gemini) with preva prompt directing it to make minutes
in markdown. This is the only expensive part of the process (more in
terms of time than money) so we cache the raw minutes to avoid
having to regenerate them.

Once all desired sessions have been minuted, Auto Minutes can assemble
the final site, gluing together the minutes for multiple sessions, adding
headers, creating index pages, etc. This gets published to GitHub pages
at [https://ekr.github.io/auto-minutes](https://ekr.github.io/auto-minutes)
and then we use Cloudflare Workers to publish the GitHub pages subdirectory
to the [https://ietfminutes.org](https://ietfminutes.org). Currently,
the GitHub pages version doesn't really work properly due to some
Jekyll issues with relative links, but I plan to fix that, or maybe
switch to a different static site generator.


## FAQ

### How much does this cost to run?

Using Gemini Flash 2.5, it costs less than $1 for each IETF meeting.
GitHub Pages and Cloudflare workers are free.

### Can I use the minutes? Can I submit them for my WG?

Yes. That's the idea! The minutes are generated in markdown
and there's a link to the raw markdown so you can just cut
and paste. You probably should double check for places
where one of the AI processing steps has screwed up (e.g., "quick"
for "QUIC"), but you don't have to.
Some of these
issues may be in the original transcript generating stage and so
are hard too fix in minutes generation.

### What about future IETF meetings?

I plan to generate future meetings as soon as the transcripts
are up.

### What about interims, etc.?

Not supported yet, because I need to scrape them and then create
a new directory structure. It's probably something I could work
out if someone cared enough.

### Can you auto-upload the minutes for me?

Not yet, because I don't have the right credentials. What you want
is for the datatracker to do this automatically, which would
actually be a lot simpler, because most of the code is working
with the IETF site and then assembling the site.

### My minutes were wrong. Will you fix them?

There is not currently any way to do that, but maybe in the future.


















