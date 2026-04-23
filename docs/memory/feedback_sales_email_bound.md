---
name: Sales leads are email-bound
description: All leads come in via email. No phone leads, no walk-ins, no web forms. This shapes the CRM intake — email is the trigger, not manual entry.
type: feedback
originSessionId: 0a49fda5-6ffd-4238-b6de-d05549bed5b0
---
All sales leads arrive via email (enquiries, tender invitations, referrals). No phone leads, no walk-ins, no web form submissions.

**Why:** This means the ideal intake flow is email-triggered, not manual-create. Janessa receives an email → creates the opportunity from it → system takes over.

**How to apply:** 
- All leads come through Outlook — two mailboxes: enquiry@laiyewseng.com.sg + Janessa's inbox
- Mail.Read app permission already granted in Azure AD (client credentials flow, .default scope)
- System can poll both mailboxes via Graph API for new enquiry emails
- Auto-create draft opportunities with client email, subject, body, attachments
- Deduplicate across the two mailboxes (CC'd to both = one lead)
- Janessa reviews drafts on CRM, confirms to activate
- Auto-reply email template references the original enquiry
