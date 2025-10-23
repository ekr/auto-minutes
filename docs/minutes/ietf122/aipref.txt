**Session Date/Time:** 20 Mar 2025 06:00

# aipref

## Summary
The inaugural meeting of the AI Preferences Working Group focused on defining the scope and direction of the group's work, including a vocabulary for expressing AI preferences, mechanisms for attaching these preferences to IETF protocols, and strategies for reconciling multiple preference expressions. Key discussions revolved around simplifying the vocabulary, attachment locations (Robots.txt, HTTP headers), opt-in/opt-out models, and the challenging issue of combining preferences. The meeting also addressed potential collaborations with other standards organizations and the need to manage expectations with policymakers.

## Key Discussion Points
*   **Charter Scope:** Review of in-scope (vocabulary, attachment, reconciliation) and out-of-scope (enforcement, bot authentication, registries, auditing) items.
*   **Vocabulary Simplicity:** Agreement on starting with a simple, extensible vocabulary, but with concerns about varying interpretations of "simple."
*   **Attachment Locations:** Discussion on using Robots.txt and HTTP headers as initial attachment mechanisms, with consideration for URL-level controls and the Robots Exclusion Protocol.
*   **Opt-in vs. Opt-out:** Exploring support for both opt-in and opt-out models, leading to a proposed "allow list" and "deny list" approach.  Emphasis on the dominant "I don't know" state and that the WG is not aiming to affect existing norms in the absence of a preference signal.
*   **Combining Preferences:** Acknowledgment of this deliverable's complexity and the need to start working on it early, possibly with examples to illustrate combination strategies.
*   **External Collaboration:** Identifying relevant SDOs to work with, particularly ITUT, and potentially sending unsolicited notifications to inform them of the working group's activities.
*   **Draft Discussion:**  Initial feedback on existing drafts including the approach to combining preferences and expiration times for the declarations. Also specific use cases for the declarations including gathering data for training, inference time usage, and RAG.

## Decisions and Action Items
*   **Action Item:** Chairs to draft and circulate Richard Barnes's "uncertainty principle" for inclusion in the meeting minutes.
*   **Action Item:**  Chairs to engage with common call to clarify its set of preferences to pass down further.
*   **Action Item:**  Chairs to contact SDOs including iso groups, and notify of working group.
*   **Action Item:**  Review details about the expiry time to the declarations.

## Next Steps
*   Finalize the agenda for the interim meeting in Brussels, incorporating feedback from this meeting.
*   Chairs to prepare details for agenda circulation prior to meeting.
*   Continue discussions on the mailing list regarding vocabulary, attachment mechanisms, and preference combination strategies.
*   Address the questions of gathering for training, gathering for inference time usage, and interaction with RAG in Brussels.
