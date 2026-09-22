# RH PLUS — Notifications (SMS et email)

Le logiciel envoie deux familles de messages :

| Message | Quand | Contenu |
|---|---|---|
| **Code de connexion** | à chaque connexion (2e étape) | code à 6 chiffres, valable 10 minutes, à usage unique |
| **Réinitialisation de mot de passe** | sur demande « mot de passe oublié » | code à 6 chiffres, valable 30 minutes |
| **Alerte de contrat** | à J-60, J-30, J-15 | échéance d'un CDD ou d'une période d'essai |
| **Facture** | émission d'une facture d'abonnement | référence, montant, échéance |

Les messages partent par **email** et, si le salarié a un numéro de mobile enregistré, par **SMS**.

---

## 1. Le mode console (par défaut)

Sans configuration, le serveur fonctionne en **mode console** : aucun message ne sort de la
machine, tout est écrit dans le journal du serveur et le code s'affiche à l'écran (hors
production). C'est ce qui permet d'essayer le logiciel immédiatement.

> **En production, ce mode est refusé.** Le serveur **s'arrête au démarrage** si `NODE_ENV=production`
> et qu'aucun canal réel n'est configuré — pour qu'on ne livre jamais un service où personne ne peut
> recevoir son code de connexion. Dérogation temporaire et explicite : `RHPLUS_ALLOW_CONSOLE_MESSAGING=1`.

Le journal des envois est consultable dans la base (`messages`) et dans l'onglet **Plateforme →
Envois de notifications** : canal, destinataire masqué (`ma•••@client.ga`), objet, statut, erreur.
**Le code lui-même n'est jamais écrit dans cette table.**

---

## 2. Configurer l'email

### SMTP (recommandé : votre boîte professionnelle)

```env
RHPLUS_MAIL=smtp
RHPLUS_MAIL_FROM=RH PLUS <notifications@rhplus.ga>
RHPLUS_SMTP_HOST=smtp.votre-hebergeur.ga
RHPLUS_SMTP_PORT=587
RHPLUS_SMTP_SECURE=false      # true pour le port 465
RHPLUS_SMTP_USER=notifications@rhplus.ga
RHPLUS_SMTP_PASS=••••••••
```

Les pièces jointes et le chargement d'URL distante sont désactivés dans le transport
(`disableUrlAccess`, `disableFileAccess`) : une injection dans un en-tête ne peut pas transformer
le serveur en relais.

### API HTTP d'un fournisseur

Si vous préférez un service d'envoi (Brevo, Mailgun, SendGrid…), utilisez le canal `http` :

```env
RHPLUS_MAIL=http
RHPLUS_MAIL_HTTP_URL=https://api.fournisseur.ga/v3/smtp/email?to={to}&subject={subject}
RHPLUS_MAIL_HTTP_METHOD=POST
RHPLUS_MAIL_HTTP_KEY=votre-cle-api     # envoyée dans l'en-tête X-Api-Key
```

Selon le fournisseur, les données peuvent voyager en paramètres d'URL (`{to}`, `{from}`, `{subject}`,
`{text}`) ou en JSON. Testez toujours le canal avant la mise en service (§4).

---

## 3. Configurer le SMS

Le Gabon est le marché prioritaire : le SMS est le canal que vos clients attendent, car il est lu
instantanément et le numéro est déjà connu de l'employeur.

### Passerelle HTTP (Airtel, Moov, agrégateur local)

```env
RHPLUS_SMS=http
RHPLUS_SMS_URL=https://passerelle.exemple.ga/send?to={to}&text={text}&sender={sender}&key={key}
RHPLUS_SMS_METHOD=POST
RHPLUS_SMS_KEY=votre-cle
RHPLUS_SMS_SENDER=RHPLUS
RHPLUS_SMS_USERNAME=votre-compte
```

Le canal `http` accepte n'importe quelle passerelle : les jetons `{to}` (numéro au format
international), `{text}`, `{sender}`, `{key}`, `{username}` sont remplacés avant l'envoi. Si la
passerelle attend du JSON, les jetons placés dans `RHPLUS_SMS_PARAMS` sont envoyés dans le corps de
la requête.

### Africa's Talking (couverture Afrique francophone)

```env
RHPLUS_SMS=africastalking
RHPLUS_SMS_USERNAME=votre-utilisateur
RHPLUS_SMS_KEY=votre-cle-api
RHPLUS_SMS_SENDER=RHPLUS
```

### Bonnes pratiques

- Numéros au **format international** (`+241 06 12 34 56`, `+241 74 00 00 00`) : la passerelle
  choisit l'opérateur, et le format reste valable si le salarié change de pays.
- Enregistrez l'expéditeur (`RHPLUS`) auprès de l'opérateur : un expéditeur non déclaré est souvent
  filtré.
- Les messages sont courts et sans donnée sensible : *« RH PLUS : votre code de connexion est
  123456. Valable 10 minutes. »*

---

## 4. Vérifier que l'envoi fonctionne

1. **Depuis l'interface** — connectez-vous avec le compte plateforme, onglet **Plateforme →
   Envois de notifications**, saisissez un email et un numéro, puis **Tester**. Le résultat
   s'affiche dans le journal des messages.
2. **Par l'API** :

```bash
curl -X POST http://localhost:3000/api/platform/messaging/test \
  -H 'content-type: application/json' -b "rhp_sid=$JETON" \
  -d '{"email":"vous@rhplus.ga","phone":"+24106123456"}'
```

3. **En ligne de commande**, sans passer par l'interface :

```bash
node -e "require('./src/db').openDatabase(); require('./src/messaging').envoyerCodeConnexion(null,{email:'vous@rhplus.ga',phone:'+24106123456',name:'Test',code:'123456'}).then(console.log)"
```

4. **Vérification automatique** : `npm run test:notifications` démarre un vrai serveur SMTP et une
   vraie passerelle HTTP sur des ports locaux, envoie un code, puis contrôle que le message contient
   bien le code et que la base ne le stocke jamais.

---

## 5. Ce qu'il reste à faire côté exploitation

- Ouvrir un compte chez un fournisseur SMTP et un fournisseur SMS, et renseigner `.env`.
- Vérifier le coût unitaire du SMS (Gabon : quelques dizaines de FCFA) et fixer le nombre de SMS
  inclus dans chaque offre.
- Conserver la trace des envois (table `messages`) : elle sert en cas de litige « je n'ai pas reçu
  mon code ».
- En cas de suspicion de fuite d'un code : la déconnexion révoque immédiatement toutes les sessions
  du compte (`token_version`), et les codes ne sont stockés que sous forme d'empreinte.
