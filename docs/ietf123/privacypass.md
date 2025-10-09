**Session Date/Time:** 23 Jul 2025 12:30

# privacypass

## Summary

The Privacy Pass working group session focused on three main presentations and discussions around token types and rate limiting mechanisms. Key topics included the current status of working group documents, Anonymous Rate-Limited Credentials (ARC), new directions in rate limiting, and Anonymous Credit Tokens. The session saw strong support for adopting ARC as a Privacy Pass token type and interest in exploring credit tokens for more flexible quota management systems.

## Key Discussion Points

### Working Group Document Status
- **Batch Tokens**: Complete and ready for shepherd writeup to IESG
- **Private Tokens and Public Metadata**: Completed working group last call, waiting for revised draft addressing feedback
- **Explorations Extension**: Recently adopted as working group item
- **Anonymous Rate Limited Credentials**: Planned for adoption call soon

### Anonymous Rate-Limited Credentials (ARC) Presentation by Kathy Yun
- **Core improvements over existing solutions**:
  - Per-client rate limiting built into cryptography rather than mediator tracking
  - One-to-many issuance ratio (create multiple tokens from single credential)
  - Better privacy (no usage pattern leakage) and lower operational overhead
- **Key technical questions discussed**:
  - **Public vs. private key verification**: Current design uses private key verification for standard NIST curves; public key verification possible with pairings
  - **Nonce visibility concerns**: Three options presented:
    1. Public nonce with arbitrary rate limit (current design, privacy concerns)
    2. Hidden nonce with power-of-two rate limit (simpler cryptography)
    3. Hidden nonce with arbitrary rate limit (more complex cryptography)
- **Strong working group support** for adoption, with preference for hidden nonce despite complexity

### Rate Limiting New Directions by Watson
- **Information-theoretic rate limiting**: New approach using giant tables indexed through polynomials, providing post-quantum security
- **Multiple technology approaches**: Circuits vs. BBS signatures, with different trade-offs in setup costs and capabilities
- **Multi-issuer possibilities** and post-quantum security considerations
- Discussion on balancing exploration of advanced cryptography with practical implementation needs

### Anonymous Credit Tokens by Sam Scott
- **Core concept**: Anonymous state machine allowing variable credit spending instead of atomic tokens
- **Key features**:
  - Variable resource allocation (different bandwidth, processing costs)
  - Abuse feedback mechanisms with counters
  - Long-term abuse tracking while maintaining privacy
  - Post-quantum security (no linkability on Q-day)
- **Use cases**: AI systems, proxy services, any system with variable resource costs
- Strong interest from implementers currently using many blind signatures for quota management

## Decisions and Action Items

### Immediate Actions
- **Chairs to initiate adoption call for ARC** - strong consensus expressed during session
- **Continue shepherd process** for Batch Tokens document to IESG
- **Wait for revised draft** addressing working group last call feedback for Private Tokens and Public Metadata

### Technical Decisions for ARC
- **Consensus to hide nonce** to address privacy concerns, despite added cryptographic complexity
- **Preference for power-of-two rate limits initially** with potential future extension to arbitrary limits
- **Support for private key verification** in initial version, with public key verification as potential future extension

## Next Steps

### ARC Development
- Finalize nonce hiding approach (likely power-of-two rate limits initially)
- Determine whether public key verifiable extension should be in same or separate specification
- Complete adoption call process

### Credit Tokens Exploration
- Develop Privacy Pass integration document showing HTTP interactions and role definitions
- Determine appropriate venue (Privacy Pass WG vs. CFRG) for standardization
- Address anonymity set calculation guidance for deployment scenarios

### General Working Group Progress
- Continue processing existing documents through IETF publication pipeline
- Evaluate need for recharter or scope adjustments based on new work directions
- Balance advanced cryptographic exploration with practical implementation requirements