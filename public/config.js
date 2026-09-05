'use strict';

/*
 * Deployment settings. Fill these in once, when you publish the site; visitors
 * never see this file and never have to set anything up themselves.
 *
 * `googleClientId` switches on "Save to Google Drive" in the Backup tab. With
 * it filled in, a visitor clicks Connect, signs in to their own Google account
 * and is done — the same deal as draw.io, which ships its own client ID on
 * app.diagrams.net and asks self-hosters to bring their own.
 *
 * It is not a secret: every visitor's browser sees it during sign-in, and it
 * only works from the origins you list under "Authorized JavaScript origins"
 * in the Google Cloud console. Leaving it empty is fine — the rest of the app
 * works, and the Backup tab still exports and restores files. See the README
 * under "Google Drive" for the five-minute registration.
 */
window.SFM_CONFIG = {
  googleClientId: '90437613968-q22k268cbnrhfvh0054v2rlovair94ea.apps.googleusercontent.com',
};
