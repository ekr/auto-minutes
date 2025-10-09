**Session Date/Time:** 23 Jul 2025 09:30

# TCPM Working Group Meeting Minutes

## Summary

The TCPM (TCP Maintenance) working group met to discuss the status of working group documents and review several individual submissions. The session covered updates to existing RFCs, new TCP option proposals, and experimental extensions. Key topics included Proportional Rate Reduction (PRR) BIS moving to RFC editor, TCP Accurate Request Option updates, TCP extended options experiments, extended timestamp options for data centers, MPTCP extensions, and opportunistic acknowledgment attacks.

## Key Discussion Points

### Working Group Document Status
- **PRR BIS (RFC 6937bis)**: Approved by IESG and queued at RFC editor, with 8 revisions since March addressing editorial improvements
- **Generalized ECN**: Expected to go to working group last call next
- **Ghost ACK**: Short document about handling acknowledgments for unsent data, should be last called soon
- **TCP EDO**: Ongoing work with another presentation scheduled

### Individual Submissions

#### TCP Accurate Request Option
- Updates to address comments from previous meeting and mailing list
- Added sender behavior for congestion window changes and retransmission handling
- Received IANA early review requesting full registry name
- Authors seeking working group reviews before potential working group last call

#### TCP Extended Options Experiment
- Proposal to expand TCP options beyond 40-byte limit using data offset field modifications
- Significant backwards compatibility issues with legacy middleboxes and implementations
- Discussion of limited domain deployment vs. broad internet experimentation
- Comparison with TCP EDO approach and its limitations

#### Extended Timestamp Options
- Microsecond granularity timestamps for data center environments
- Explicit delay signaling to separate network RTT from receiver-side delays
- Needed for Swift congestion control deployment in Google Cloud
- Complex scenarios with retransmissions and spurious timeouts

#### MPTCP Extensions
- Two independent extensions: DSS extension for >64KB packets and external key support
- DSS extension would extend data level length to 4 octets and drop checksum
- External keys would use application-level protocol keys (TLS, SSH) for MPTCP security
- Both extensions designed with fallback to normal MPTCP

#### Opportunistic ACK in TCP
- Analysis of attacks where receivers send ACKs for unreceived data
- Similar to QUIC issue but TCP lacks packet number skipping solution
- Proposed mitigation involves intentionally dropping segments to detect false ACKs
- Performance overhead concerns and detection challenges discussed

## Decisions and Action Items

### PRR BIS
- **Action**: Neil Cardwell to send email to mailing list with 2-week comment period before forwarding to RFC editor
- **Action**: Working group members to provide final editorial feedback within 2 weeks

### TCP Accurate Request Option
- **Action**: Authors to address Neil Cardwell's comments about retransmission timeout behavior
- **Action**: Working group members encouraged to review document before potential working group last call
- **Action**: Authors to provide API specification text if there is interest

### TCP Extended Options
- **Action**: Experiment to proceed with interested parties
- **Action**: Further discussion on backwards compatibility strategies including "happy eyeballs" approach

## Next Steps

- PRR BIS to be forwarded to RFC editor after 2-week comment period
- TCP Accurate Request Option awaiting working group reviews and addressing technical comments
- TCP Extended Options experiment seeking additional participants
- Extended Timestamp Options draft to be submitted soon
- MPTCP extensions drafts in development
- Opportunistic ACK research to continue with focus on low-overhead mitigation strategies