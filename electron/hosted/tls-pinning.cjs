const { X509Certificate } = require('node:crypto');
const { hostedEndpoints, isPinnedGatewayCertificate } = require('./endpoints.cjs');

function certificateFingerprint256(certificate) {
  if (certificate?.fingerprint256) return certificate.fingerprint256;
  try {
    return certificate?.data ? new X509Certificate(certificate.data).fingerprint256 : '';
  } catch {
    return '';
  }
}

function certificateVerificationResult(request, getEndpoints = hostedEndpoints) {
  const verificationResult = String(request?.verificationResult || '').replace(/^net::/, '');
  if (verificationResult === 'OK') return 0;
  if (verificationResult !== 'ERR_CERT_AUTHORITY_INVALID') return -2;

  const endpoints = getEndpoints();
  try {
    const gateway = new URL(endpoints.gateway);
    const hostname = String(request?.hostname || '').toLowerCase();
    const matchesGatewayHost = hostname === gateway.hostname.toLowerCase()
      || hostname === gateway.host.toLowerCase();
    return matchesGatewayHost && isPinnedGatewayCertificate({
      url: endpoints.gateway,
      fingerprint256: certificateFingerprint256(request?.certificate),
      endpoints,
    }) ? 0 : -2;
  } catch {
    return -2;
  }
}

function installHostedCertificateVerifier(session, getEndpoints = hostedEndpoints) {
  if (typeof session?.setCertificateVerifyProc !== 'function') return;
  session.setCertificateVerifyProc((request, callback) => {
    callback(certificateVerificationResult(request, getEndpoints));
  });
}

function registerHostedCertificatePin(app, getEndpoints = hostedEndpoints) {
  app.on('certificate-error', (event, _webContents, url, error, certificate, callback) => {
    if (error === 'net::ERR_CERT_AUTHORITY_INVALID' && isPinnedGatewayCertificate({
      url,
      fingerprint256: certificateFingerprint256(certificate),
      endpoints: getEndpoints(),
    })) {
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
  });
}

module.exports = {
  certificateFingerprint256,
  certificateVerificationResult,
  installHostedCertificateVerifier,
  registerHostedCertificatePin,
};
