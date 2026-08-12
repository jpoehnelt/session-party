ALTER TABLE `submissions` ADD `pending_decision` text CONSTRAINT "submissions_pending_decision" CHECK(
  `pending_decision` is null
  or (
    `pending_decision` in ('accepted', 'rejected')
    and `status` in ('submitted', 'in_review', 'waitlist')
  )
);
