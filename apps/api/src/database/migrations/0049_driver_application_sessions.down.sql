-- Reverts 0049 completely.
-- Data lost: personal application link sessions (their audit entries stay), the applications
-- received through them (answers and sealed SSN), the rows naming their documents and the MVR / PSP
-- authorization evidence rows. The stored bytes (documents under driver-application/<company>/…,
-- signature images) stay in storage, and any document already filed into the qualification file
-- stays there with its audit trail. Take a backup of these four tables before running this.
DROP TABLE IF EXISTS "hiring_driver_authorizations";
DROP TABLE IF EXISTS "hiring_driver_application_files";
DROP TABLE IF EXISTS "hiring_driver_applications";
DROP TABLE IF EXISTS "hiring_application_sessions";
