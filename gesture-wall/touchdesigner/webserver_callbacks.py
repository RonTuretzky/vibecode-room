# Web Server DAT callbacks (names verified against docs.derivative.ca/Web_Server_DAT).
# `clients` is the FALLBACK send registry; hands_stream.py prefers the documented
# webSocketConnections member and falls back to this list.
clients = []
def onHTTPRequest(webServerDAT, request, response):
    response['statusCode'] = 200; response['statusReason'] = 'OK'
    response['data'] = 'vibersyn hands stream: %d ws client(s)' % len(clients)
    return response
def onWebSocketOpen(webServerDAT, client, uri):
    if client not in clients: clients.append(client)
def onWebSocketClose(webServerDAT, client):
    if client in clients: clients.remove(client)
def onWebSocketReceiveText(webServerDAT, client, data):
    pass  # browser hello — informational only, ignored by design
def onServerStart(webServerDAT): clients.clear()
def onServerStop(webServerDAT): clients.clear()
